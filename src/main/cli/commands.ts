import path from 'node:path'
import type { HmlApi } from '../../shared/ipc'
import type { HmlEvent, InstalledMod, ProfileManifest } from '../../shared/types'

/** What the CLI needs from HML's services (a running app's, or a headless one's). */
export type CliPort = Pick<
  HmlApi,
  | 'getGame'
  | 'listProfiles'
  | 'createProfile'
  | 'installFromPaths'
  | 'uninstallMod'
  | 'setModEnabled'
  | 'launch'
  | 'getSettings'
> & {
  /** Games that have a data folder (a profile was made for them at some point). */
  knownGames(): Promise<{ label: string; displayName: string }[]>
  /** Tells an open HML window a profile changed (a no-op without a window). */
  emit(e: HmlEvent): void
}

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export const CLI_USAGE = `HML command line: install and manage mods through HML instead of copying files.

Usage: hml <command> [arguments] [--profile <id|name>] [--json]

Commands:
  games                              Games HML has profiles for (id and name)
  profiles <game>                    A game's profiles; * marks the one HML has selected
  new-profile <game> <name>          Create a profile (handy as a clean test bed)
  mods <game>                        Mods in a profile
  install <game> <path>...           Install (or reinstall) mods from .zip files or folders
  uninstall <game> <mod-id>          Remove a mod and its files
  enable <game> <mod-id>             Enable a mod
  disable <game> <mod-id>            Disable a mod
  launch <game> [--vanilla]          Start the game with the profile's mods (or without any)
  help                               This text

Options:
  --profile <id|name>  Profile to use. Defaults to the one selected in HML, or the only one.
  --json               Print machine-readable JSON instead of text.

<game> is a game id from \`hml games\` (like "repo" or "lethal-company") or its name.

Installing a mod you are developing:
  Point install at a build folder or zip laid out like a Thunderstore package: a manifest.json
  ("name" and "version_number") at the root, plus the mod files (for BepInEx, the plugin DLLs,
  optionally under plugins/, config/ or patchers/). HML places the files where the game's mod
  loader expects them, records them so uninstall removes exactly them, and keeps user config on
  reinstall. Without a manifest.json the folder or zip name becomes the mod id, at version 0.0.0.
  Installing again with the same mod id replaces the previous build.

If HML is open, commands run inside it and its window refreshes. Otherwise they run without a
window. Exit code 0 means success; errors go to stderr.
`

class CliError extends Error {}

interface Parsed {
  command: string
  positional: string[]
  profile?: string
  json: boolean
  vanilla: boolean
}

export function parseCliArgs(argv: string[]): Parsed {
  const positional: string[] = []
  let profile: string | undefined
  let json = false
  let vanilla = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') json = true
    else if (a === '--vanilla') vanilla = true
    else if (a === '--profile' || a === '-p') {
      const v = argv[++i]
      if (v === undefined) throw new CliError(`${a} needs a profile id or name.`)
      profile = v
    } else if (a.startsWith('--profile=')) profile = a.slice('--profile='.length)
    else if (a === '-h' || a === '--help') positional.unshift('help')
    else if (a.startsWith('-') && a !== '-') throw new CliError(`Unknown option: ${a}`)
    else positional.push(a)
  }
  const [command = 'help', ...rest] = positional
  return { command, positional: rest, profile, json, vanilla }
}

/** Splits `argv` at HML's `--cli` flag: what follows is a CLI command, or null without one. */
export function findCliArgs(argv: string[]): string[] | null {
  const i = argv.indexOf('--cli')
  return i === -1 ? null : argv.slice(i + 1)
}

const lower = (s: string): string => s.toLowerCase()

async function resolveGame(
  port: CliPort,
  arg: string
): Promise<{ label: string; displayName: string }> {
  const direct = await port.getGame(arg)
  if (direct) return { label: direct.label, displayName: direct.displayName }
  const known = await port.knownGames()
  const match =
    known.find((g) => lower(g.label) === lower(arg)) ??
    known.find((g) => lower(g.displayName) === lower(arg))
  if (match) return match
  const partial = known.filter((g) => lower(g.displayName).includes(lower(arg)))
  if (partial.length === 1) return partial[0]
  const hint =
    partial.length > 1
      ? ` Did you mean one of: ${partial.map((g) => g.label).join(', ')}?`
      : ' Run `hml games` to list game ids.'
  throw new CliError(`Unknown game: ${arg}.${hint}`)
}

async function resolveProfile(
  port: CliPort,
  game: { label: string; displayName: string },
  arg: string | undefined
): Promise<ProfileManifest> {
  const profiles = await port.listProfiles(game.label)
  if (profiles.length === 0) {
    throw new CliError(
      `${game.displayName} has no profiles. Create one with \`hml new-profile ${game.label} <name>\`.`
    )
  }
  if (arg !== undefined) {
    const p =
      profiles.find((x) => x.id === arg) ?? profiles.find((x) => lower(x.name) === lower(arg))
    if (!p) {
      throw new CliError(
        `${game.displayName} has no profile "${arg}". Profiles: ${profiles.map((x) => x.id).join(', ')}`
      )
    }
    return p
  }
  if (profiles.length === 1) return profiles[0]
  const selected = (await port.getSettings()).lastProfile[game.label]
  const p = profiles.find((x) => x.id === selected)
  if (p) return p
  throw new CliError(
    `${game.displayName} has several profiles; pick one with --profile. Profiles: ${profiles.map((x) => x.id).join(', ')}`
  )
}

function need(args: string[], n: number, usage: string): void {
  if (args.length < n) throw new CliError(`Usage: hml ${usage}`)
}

const modLine = (m: InstalledMod): string =>
  `${m.enabled ? ' ' : '-'} ${m.id}  ${m.version}  (${m.source.kind})`

const modJson = (m: InstalledMod): Record<string, unknown> => ({
  id: m.id,
  name: m.name,
  version: m.version,
  enabled: m.enabled,
  source: m.source.kind,
  files: m.files
})

/**
 * Runs one CLI command. Relative paths are taken from `cwd` (the caller's folder, which differs
 * from HML's when the command is forwarded to a running app).
 */
export async function runCli(port: CliPort, argv: string[], cwd: string): Promise<CliResult> {
  let json = argv.includes('--json')
  try {
    const p = parseCliArgs(argv)
    json = p.json
    const out = (text: string, data: unknown): CliResult => ({
      code: 0,
      stdout: json
        ? JSON.stringify(data, null, 2) + '\n'
        : text.endsWith('\n')
          ? text
          : text + '\n',
      stderr: ''
    })
    const args = p.positional
    const changed = (game: string, profileId: string, message: string): void =>
      port.emit({ type: 'cli-changed', game, profileId, message })

    switch (p.command) {
      case 'help':
        return { code: 0, stdout: CLI_USAGE, stderr: '' }

      case 'games': {
        const games = await port.knownGames()
        const text = games.length
          ? games.map((g) => `${g.label}  ${g.displayName}`).join('\n')
          : 'No games yet. Pick a game in HML first, or use any game id with `hml new-profile`.'
        return out(text, games)
      }

      case 'profiles': {
        need(args, 1, 'profiles <game>')
        const game = await resolveGame(port, args[0])
        const profiles = await port.listProfiles(game.label)
        const selected = (await port.getSettings()).lastProfile[game.label]
        const text = profiles.length
          ? profiles
              .map(
                (x) =>
                  `${x.id === selected ? '*' : ' '} ${x.id}  ${x.name}  (${x.mods.length} mods)`
              )
              .join('\n')
          : `${game.displayName} has no profiles.`
        return out(
          text,
          profiles.map((x) => ({
            id: x.id,
            name: x.name,
            mods: x.mods.length,
            selected: x.id === selected
          }))
        )
      }

      case 'new-profile': {
        need(args, 2, 'new-profile <game> <name>')
        const game = await resolveGame(port, args[0])
        const created = await port.createProfile(game.label, args.slice(1).join(' '))
        changed(game.label, created.id, `Created profile ${created.name}`)
        return out(`Created profile ${created.id} for ${game.displayName}`, {
          id: created.id,
          name: created.name
        })
      }

      case 'mods': {
        need(args, 1, 'mods <game>')
        const game = await resolveGame(port, args[0])
        const profile = await resolveProfile(port, game, p.profile)
        const text = profile.mods.length
          ? `${game.displayName} / ${profile.name} (- = disabled)\n` +
            profile.mods.map(modLine).join('\n')
          : `${game.displayName} / ${profile.name} has no mods.`
        return out(text, { game: game.label, profile: profile.id, mods: profile.mods.map(modJson) })
      }

      case 'install': {
        need(args, 2, 'install <game> <path>...')
        const game = await resolveGame(port, args[0])
        const profile = await resolveProfile(port, game, p.profile)
        const files = args.slice(1).map((f) => path.resolve(cwd, f))
        const mods = await port.installFromPaths(game.label, profile.id, files)
        const names = mods.map((m) => `${m.name} ${m.version}`).join(', ')
        changed(game.label, profile.id, `Installed ${names}`)
        return out(
          mods
            .map(
              (m) =>
                `Installed ${m.id} ${m.version} into ${game.displayName} / ${profile.name} (${m.files.length} files)`
            )
            .join('\n'),
          { game: game.label, profile: profile.id, installed: mods.map(modJson) }
        )
      }

      case 'uninstall':
      case 'enable':
      case 'disable': {
        need(args, 2, `${p.command} <game> <mod-id>`)
        const game = await resolveGame(port, args[0])
        const profile = await resolveProfile(port, game, p.profile)
        const mod =
          profile.mods.find((m) => m.id === args[1]) ??
          profile.mods.find(
            (m) => lower(m.id) === lower(args[1]) || lower(m.name) === lower(args[1])
          )
        if (!mod) {
          throw new CliError(
            `${profile.name} has no mod "${args[1]}". Run \`hml mods ${game.label}\` to list them.`
          )
        }
        let verb: string
        if (p.command === 'uninstall') {
          await port.uninstallMod(game.label, profile.id, mod.id)
          verb = 'Uninstalled'
        } else {
          await port.setModEnabled(game.label, profile.id, mod.id, p.command === 'enable')
          verb = p.command === 'enable' ? 'Enabled' : 'Disabled'
        }
        changed(game.label, profile.id, `${verb} ${mod.name}`)
        return out(`${verb} ${mod.id} in ${game.displayName} / ${profile.name}`, {
          game: game.label,
          profile: profile.id,
          mod: mod.id,
          action: p.command
        })
      }

      case 'launch': {
        need(args, 1, 'launch <game> [--vanilla]')
        const game = await resolveGame(port, args[0])
        const profile = p.vanilla ? null : await resolveProfile(port, game, p.profile)
        await port.launch(game.label, profile?.id ?? null, p.vanilla ? 'vanilla' : 'modded')
        return out(
          `Launched ${game.displayName} ${profile ? `with ${profile.name}` : 'without mods'}`,
          { game: game.label, profile: profile?.id ?? null, mode: p.vanilla ? 'vanilla' : 'modded' }
        )
      }

      default:
        throw new CliError(`Unknown command: ${p.command}. Run \`hml help\` for the list.`)
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return {
      code: e instanceof CliError ? 2 : 1,
      stdout: '',
      stderr: json ? JSON.stringify({ error: message }) + '\n' : `hml: ${message}\n`
    }
  }
}
