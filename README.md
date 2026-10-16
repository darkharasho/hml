# hml

HML (Haro's Mod Loader) is a desktop mod manager modeled closely on r2modman, built as an Electron app with a modern Tailwind UI. Users can search for and subscribe to mods from Thunderstore or Nexus Mods, with per-game profiles. Its defining feature is GitHub integration: paste a repo URL and HML pulls the latest release zip, installs and configures it, and keeps it updated automatically.

## Development

```
npm install
npm run dev     # launch the app with hot reload
npm test        # run unit tests (vitest, 2 workers)
npm run build   # typecheck and build
```
