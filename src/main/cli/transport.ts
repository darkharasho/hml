import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { CliResult } from './commands'

/**
 * A running HML answers CLI commands on a local socket (a named pipe on Windows). Each request
 * carries a token HML writes to its data folder, readable only by the same user, so other
 * users on the machine can't drive it.
 */
export interface CliEndpoint {
  socket: string
  tokenFile: string
}

export function cliEndpoint(userData: string, platform: NodeJS.Platform): CliEndpoint {
  const tokenFile = path.join(userData, 'cli-token')
  if (platform === 'win32') {
    const id = createHash('sha256').update(userData.toLowerCase()).digest('hex').slice(0, 16)
    return { socket: `\\\\.\\pipe\\hml-cli-${id}`, tokenFile }
  }
  return { socket: path.join(userData, 'cli.sock'), tokenFile }
}

interface Request {
  token: string
  argv: string[]
  cwd: string
}

/** Most bytes one request may send; a command line is far smaller. */
const MAX_REQUEST = 1024 * 1024

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Starts answering CLI requests. Call only while holding the single-instance lock: a socket
 * file left by a crashed HML is removed first. Returns a function that stops the server.
 */
export async function startCliServer(
  endpoint: CliEndpoint,
  run: (argv: string[], cwd: string) => Promise<CliResult>
): Promise<() => Promise<void>> {
  const token = randomBytes(32).toString('hex')
  await fs.mkdir(path.dirname(endpoint.tokenFile), { recursive: true })
  await fs.writeFile(endpoint.tokenFile, token, { mode: 0o600 })
  await fs.chmod(endpoint.tokenFile, 0o600).catch(() => undefined)
  if (!endpoint.socket.startsWith('\\\\')) await fs.rm(endpoint.socket, { force: true })

  const server = net.createServer((conn) => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('error', () => undefined)
    conn.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_REQUEST) return void conn.destroy()
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      conn.pause()
      const reply = (r: CliResult): void => void conn.end(JSON.stringify(r) + '\n')
      let req: Request
      try {
        req = JSON.parse(buf.slice(0, nl)) as Request
      } catch {
        return reply({ code: 1, stdout: '', stderr: 'hml: malformed request\n' })
      }
      if (
        typeof req.token !== 'string' ||
        !sameToken(req.token, token) ||
        !Array.isArray(req.argv) ||
        req.argv.some((a) => typeof a !== 'string') ||
        typeof req.cwd !== 'string'
      ) {
        return reply({ code: 1, stdout: '', stderr: 'hml: request refused\n' })
      }
      run(req.argv, req.cwd).then(reply, (e) =>
        reply({ code: 1, stdout: '', stderr: `hml: ${e instanceof Error ? e.message : e}\n` })
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint.socket, () => {
      server.off('error', reject)
      resolve()
    })
  })
  if (!endpoint.socket.startsWith('\\\\')) {
    await fs.chmod(endpoint.socket, 0o600).catch(() => undefined)
  }
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      if (!endpoint.socket.startsWith('\\\\')) void fs.rm(endpoint.socket, { force: true })
      void fs.rm(endpoint.tokenFile, { force: true })
    })
}

/**
 * Sends a command to a running HML. Null when none is listening (no socket, or no token), so the
 * caller can run the command itself.
 */
export async function sendCliRequest(
  endpoint: CliEndpoint,
  argv: string[],
  cwd: string
): Promise<CliResult | null> {
  const token = await fs.readFile(endpoint.tokenFile, 'utf8').catch(() => null)
  if (!token) return null
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(endpoint.socket)
    let buf = ''
    let connected = false
    conn.setEncoding('utf8')
    conn.on('connect', () => {
      connected = true
      conn.write(JSON.stringify({ token: token.trim(), argv, cwd } satisfies Request) + '\n')
    })
    conn.on('data', (c: string) => (buf += c))
    conn.on('error', (e) => (connected ? reject(e) : resolve(null)))
    conn.on('end', () => {
      try {
        resolve(JSON.parse(buf) as CliResult)
      } catch {
        reject(new Error('HML closed the connection without answering.'))
      }
    })
  })
}
