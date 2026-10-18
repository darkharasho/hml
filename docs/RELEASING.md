# Releasing HML

HML ships signed, auto-updating desktop builds. A push of a `v*` tag runs
`.github/workflows/release.yml`, which builds Linux/Windows/macOS artifacts,
publishes them to a GitHub Release, and fills the notes from `RELEASE_NOTES.md`.
Installed copies of HML update themselves from that release via
`electron-updater` (`src/main/updater.ts`).

## Cutting a release

1. **Bump the version** in `package.json` (no git tag yet):
   ```bash
   npm version patch --no-git-tag-version   # or minor / major
   ```
2. **Write the release notes.** Ask Claude to write `RELEASE_NOTES.md` for the
   new version — it reads the commits/diff since the last tag and writes the
   `Version v<version> — <date>` section by hand, following
   `docs/release-notes-style.md`. (No AI/network call lives in the build; the
   notes are authored at release time.)
3. **Tag + push** (this is the trigger):
   ```bash
   npm run release
   ```
   `scripts/release.mjs` verifies `RELEASE_NOTES.md` has a section for the
   current version, commits it if changed, then creates and pushes `v<version>`.
   The tag push starts the build.

`RELEASE_NOTES.md` always contains only the version currently being released —
the workflow extracts the `Version v<tag> — <date>` section for the release body
(`node scripts/releaseNotes.mjs v<version>` prints what it will use).

A pushed tag goes live once the builds finish. To fix a bad release, bump the
version and release again.

## Required secrets / variables (GitHub repo settings)

The macOS signing secrets are **already set** on `darkharasho/hml` (loaded from
1Password with `gh secret set`, see below). If they go missing, the `build-mac`
job fails at "Verify macOS signing identity is visible" and the release stays a
draft (the publish job needs every build).

| Name | Type | Purpose |
| --- | --- | --- |
| `CSC_LINK` | secret | base64 of the Developer ID Application `.p12`. |
| `CSC_KEY_PASSWORD` | secret | the `.p12` export password. |
| `APPLE_ID` | secret | Apple ID email (for notarization). |
| `APPLE_APP_SPECIFIC_PASSWORD` | secret | app-specific password (for notarization). |
| `APPLE_TEAM_ID` | secret | Apple Developer Team ID (`YMPSC6RQ4F`). |

`GITHUB_TOKEN` is provided automatically. Release notes are written by hand, so
no AI API key is needed.

## macOS signing

The `build-mac` job imports the cert into a temporary keychain and hands
electron-builder `CSC_KEYCHAIN`, then notarizes with the `APPLE_*` values
(`mac.notarize: true` in `electron-builder.yml`). The cert is a Developer ID
Application cert for MICHAEL ALLEN STEPHENS (team `YMPSC6RQ4F`), pulled from the
1Password item `Private/Apple App Specific Password` — the same one AxiRoster uses.

### Loading the secrets from 1Password

```bash
ITEM="op://Private/Apple App Specific Password"
op read "$ITEM/bt4xtlotikkrchkzwd6wdqkru4" | gh secret set CSC_LINK -R darkharasho/hml              # Cert Base64 (SAI section)
op read "$ITEM/etntefqzgenf3zb2egcwgqpetu" | gh secret set CSC_KEY_PASSWORD -R darkharasho/hml      # Cert Password (SAI section)
op read "$ITEM/username"                    | gh secret set APPLE_ID -R darkharasho/hml
op read "$ITEM/password"                    | gh secret set APPLE_APP_SPECIFIC_PASSWORD -R darkharasho/hml
op read "$ITEM/juapwaxqpqluusuqhjaax6im2i"  | gh secret set APPLE_TEAM_ID -R darkharasho/hml
```

> The same item also has a `Cert2 (TAI)` section — a second, equally valid
> Developer ID Application cert for the same team. Either works; we use the SAI one.
> To ship unsigned mac builds, set `mac.notarize` to `false` and drop the
> signing steps — but auto-update won't work on macOS for unsigned apps.

## What the workflow does

- **test** — `npm ci`, typecheck, lint, unit tests.
- **build** (matrix: linux AppImage, win nsis) and **build-mac** (dmg + zip,
  x64 and arm64) — `npm run build` then `electron-builder … --publish always`
  uploads to a **draft** GitHub release for the tag. The mac job signs +
  notarizes.
- **publish** — sets the release body from `RELEASE_NOTES.md` and flips the
  release out of draft.

## Release files

| File | Platform |
| --- | --- |
| `hml-<version>.AppImage` | Linux (the only Linux build HML can update) |
| `hml-<version>-setup.exe` (+ `.blockmap`) | Windows installer |
| `hml-<version>-mac-x64.dmg`, `hml-<version>-mac-arm64.dmg` | macOS installers |
| `hml-<version>-mac-x64.zip`, `hml-<version>-mac-arm64.zip` | macOS, used by auto-update |
| `latest.yml`, `latest-linux.yml`, `latest-mac.yml` | update feeds read by `electron-updater` |

`resources/ecosystem-snapshot.json` is committed and shipped as an extra
resource, so the build generates nothing beforehand.

## Auto-update in the app

Installed builds check on launch and every 6 hours, download in the background,
and install on quit — or right away from the titlebar's "Restart to update"
pill. Settings shows the version and a "Check for updates" button. Dev builds
(`npm run dev`) and Linux builds run outside an AppImage never check.
