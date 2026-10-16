import path from 'node:path'

/**
 * Where the bundled ecosystem snapshot lives. Packaged builds ship it via electron-builder
 * `extraResources` at `<resources>/ecosystem-snapshot.json`, outside app.asar; dev uses the
 * bundler-resolved project path.
 */
export function resolveSnapshotPath(opts: {
  isPackaged: boolean
  resourcesPath: string
  devPath: string
}): string {
  return opts.isPackaged ? path.join(opts.resourcesPath, 'ecosystem-snapshot.json') : opts.devPath
}
