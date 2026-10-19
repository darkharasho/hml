import path from 'node:path'
import type { LaunchMode } from '../../shared/types'
import { toProtonPath } from './launchPlan'

/**
 * Godot Mod Loader games (Brotato, Dome Keeper, …) ship the loader in the game itself, so
 * nothing is copied into the game folder. A modded launch, as r2modman's, runs the loader's
 * setup script and points it at the profile's `mods` folder, where each mod is a zip. Vanilla
 * passes nothing. The game reads the path itself, so a Proton game gets a Windows path.
 */
export function godotModArgs(i: {
  mode: LaunchMode
  profileDir: string
  proton: boolean
}): string[] {
  if (i.mode === 'vanilla') return []
  const mods = path.join(i.profileDir, 'mods')
  return [
    '--script',
    'res://addons/mod_loader/mod_loader_setup.gd',
    '--enable-mods',
    '--mods-path',
    i.proton ? toProtonPath(mods) : mods
  ]
}
