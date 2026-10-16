## Project Context

HML (Haro's Mod Loader) is a desktop mod manager modeled closely on r2modman, built as an Electron app with a modern Tailwind UI. Users can search for and subscribe to mods from Thunderstore or Nexus Mods, with per-game profiles. Its defining feature is GitHub integration: paste a repo URL and HML pulls the latest release zip, installs and configures it, and keeps it updated automatically.

## Goals

- Electron desktop app with a modern Tailwind UI that works closely like r2modman: pick a game, manage separate mod profiles, install and enable/disable mods, launch the game modded or vanilla
- Search, subscribe to and install mods from Thunderstore and Nexus Mods
- Main feature: paste a GitHub repo URL and HML downloads the latest release zip, installs it into the active profile, and updates it automatically when new releases come out
- v1 requirement: profile share codes like r2modman. Export a profile as a short code (and as a file) and import someone else's code to rebuild the same mod list with matching versions, including GitHub-sourced and Nexus mods

## Out of scope

- Hosting or publishing mods (HML only consumes Thunderstore, Nexus, and GitHub)
- Building a new mod repository or backend service

## Suggested stack

- **Electron** — Cross-platform desktop app with filesystem access for installing mods, same approach as r2modman
- **Tailwind CSS** — Requested by the user for a modern, consistent design
- **TypeScript + Vite + React** — Suggested default: typed IPC between main and renderer, fast dev builds; framework can be swapped
- **GitHub Releases REST API** — Find the latest release and its zip assets for URL-based installs and update checks
- **Thunderstore API / Nexus Mods API** — Mod search, metadata, and downloads for the two subscription sources
