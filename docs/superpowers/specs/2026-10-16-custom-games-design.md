# Custom games: installed Steam games and loaders from GitHub

Project 1 of 3 in the "games outside the catalogs" work. Project 2 adds MelonLoader and UE4SS; project 3 adds Nexus dependencies. This design covers only project 1.

## Intent

The user makes their own mods for games that are on neither Thunderstore nor Nexus, for example Trash Day. Today HML's game list comes only from the Thunderstore ecosystem catalog and Nexus search, so searching "trash" shows three unrelated Nexus games and not Trash Day, even though it is installed through Steam. The user's mods are GitHub repos with releases, and HML's GitHub install and auto-update is its defining feature, so a game like Trash Day should become a first-class HML game: profiles, enable/disable, GitHub mods with auto-update, modded and vanilla launch.

Success: the user types "trash", sees Trash Day (marked as an installed Steam game), opens it, confirms the suggested loader (BepInEx), and HML installs BepInEx into the profile from BepInEx's own GitHub releases. The user pastes their mod's repo URL, it installs, and "Launch modded" starts Trash Day with the mod loaded.

## Goals

1. **Installed Steam games appear in game search.** HML enumerates `appmanifest_*.acf` in every Steam library (`listLibraries` already finds the libraries) and includes installed games that match the query and are not already a catalog game (same Steam app id) or a saved custom game. They appear in their own group, "Installed on Steam", after catalog results and before Nexus results. Steam tools and runtimes are excluded (Proton, Steam Linux Runtime, Steamworks Common Redistributables, and similar non-games).
   - With an empty query, the game picker also lists installed Steam games the user has already added as custom games alongside the user's other games (whatever the picker shows for catalog games today); un-added Steam games show only when searched.
2. **Adding a custom game.** Opening an installed Steam game from search adds it as a saved custom game (persisted, like Nexus-added games are in `nexus-added-games.json`). Its GameDef has the Steam app id, display name from the manifest, Steam install folder, `packageIndex: null`, and the loader chosen in goal 4.
   - A user can also add a game by picking its folder ("Add a game by folder…" in the picker). That covers games not installed through Steam. Such a game has `steamAppId: null`.
   - A custom game can be removed from HML (its profiles are left on disk unless the user also deletes them; follow how the app handles removing anything else).
3. **Loader detection and choice.** When a custom game is added, HML inspects the game folder and suggests a loader:
   - Unity Mono: `<Name>_Data/Managed/Assembly-CSharp.dll` (or `UnityPlayer.dll` with a `Managed` folder) → BepInEx 5 (Mono).
   - Unity IL2CPP: `GameAssembly.dll` plus `<Name>_Data/il2cpp_data` → BepInEx 6 (IL2CPP).
   - Anything else → "No loader" (mods are copied into the game folder, same as Nexus deploy games), with the option to pick BepInEx anyway.
   - The user confirms or changes the choice in a small dialog when adding, and can change it later from the game's menu. Choices offered in this project: BepInEx 5 (Mono), BepInEx 6 (Mono), BepInEx 6 (IL2CPP), No loader. MelonLoader and UE4SS appear in project 2.
   - Detection also fills `exeNames` (the game's main `.exe`, used by the Windows running-game check) and `dataFolderName`.
4. **Loader installed from its official GitHub releases.** For a BepInEx game, HML installs BepInEx into each new profile as a GitHub mod from the `BepInEx/BepInEx` repo, so it updates like any other GitHub mod. The release asset is chosen by the loader choice and platform: Windows x64 build for Windows and for Proton games on Linux; Mono vs IL2CPP build per the choice; BepInEx 5 vs 6 per the choice (BepInEx 6 is a pre-release on GitHub — the 6 choices track the newest 6.x release including pre-releases; the 5 choice tracks the newest stable 5.x and never moves to 6). The existing raw-BepInEx recognition (`isRawBepInEx`, `provides` the loader ids) installs it as the profile's loader, so Thunderstore-style mods that depend on BepInExPack treat it as satisfied.
   - Installing the loader happens when a profile is created for the game, and HML offers it again (one click) on any profile of a BepInEx game that lacks a loader, the same place the existing "no BepInEx" launch warning shows.
5. **Sources per game.** The game's browse view offers each source that applies: Thunderstore when the game has a Thunderstore community, Nexus when it has a Nexus domain (the existing name lookup and manual override apply to custom games too), and GitHub (paste a URL) for every game. "Install from file" (zip, drag and drop) stays as a secondary fallback action, visually less prominent than the three primary sources. For a custom game with no Thunderstore community and no Nexus match, GitHub is the primary action.
6. **Launch.** Steam custom games launch exactly like catalog BepInEx games today (Steam `-applaunch` with doorstop arguments, Proton path handling, IL2CPP flags). BepInEx 6 needs the doorstop arguments it expects; the existing doorstop version detection decides v3/v4 flags. "No loader" games launch through Steam with no extra arguments (modded and vanilla differ only in which files are deployed).
7. **Share codes.** A profile for a custom game exports and imports like any other. The export identifies the game by Steam app id when it has one (so it matches on another machine where the game is installed but not yet added; importing adds it as a custom game with the exported loader choice), otherwise by display name, and refuses with a clear message if the importing machine doesn't have the game.

8. **Mods only when launched through HML (r2modman model).** Mods live in HML profiles, never in the game folder. Launching the game from Steam (or "Launch vanilla" in HML) runs it unmodded; only "Launch modded" in HML injects the profile's loader and mods. Nothing HML leaves in the game folder may make a plain Steam launch load mods: after a modded launch, the doorstop files HML copied there must not point at anything when the game is started from Steam.
9. **Existing manual loader installs.** When a BepInEx game is added (custom or catalog) and HML finds a loader installed by hand in the game folder (a `BepInEx/` folder, plus the doorstop files `winhttp.dll`, `doorstop_config.ini`, `.doorstop_version`, and BepInEx's `changelog.txt`), HML prompts: "<Game> has BepInEx installed in its game folder. HML manages mods per profile and only loads them when you launch through HML. Remove the manual install?" with "Remove" and "Keep". HML does not import anything from it into a profile; the user reinstalls their mods through HML.
   - "Remove" moves those files out of the game folder into a backup folder in HML's data directory (named per game and date) rather than deleting them, and says where they went.
   - "Keep" leaves the folder alone and remembers the choice for that game; the game's menu has "Remove manual BepInEx install…" to do it later.

## Non-goals

- MelonLoader, UE4SS and one-game loaders (project 2).
- Nexus dependency handling (project 3).
- Browsing or searching GitHub for mods; GitHub stays paste-a-URL.
- Non-Steam storefronts (Epic, GOG, Xbox) as discovered libraries; those games are added by folder.
- Native Linux games with loaders (HML already refuses modded launches of native Linux games).

## Anti-goals

- Steam tools, runtimes, soundtracks or demos cluttering game search.
- An installed Steam game that already has a catalog entry appearing twice.
- The user having to know what Mono, IL2CPP or doorstop are to get a working setup when detection is right; the detected choice is the default and labeled plainly ("Unity (Mono) — BepInEx 5, recommended").
- Breaking anything about catalog or Nexus games.

## Constraints

- Builds on existing code: `listLibraries`/`findAppInstall` (steam.ts), GitHub install/auto-update (github/service.ts), raw BepInEx recognition and `provides` (installer.ts), the deploy path for no-loader games (deploy.ts, `loader: 'deploy'`), the existing launch plan, and the saved-games pattern of `nexus-added-games.json`.
- No network needed to list installed Steam games. The GitHub release download for the loader uses the existing GitHub client (token optional, rate-limit handling as today).
- Tests never hit the network or use the user's tokens.
- Windows running-game check (Ruling G1) applies to custom games via the detected `exeNames`.

## Decided by the user

- Installed Steam games must show up in game search even when neither Thunderstore nor Nexus lists them.
- Thunderstore, Nexus and GitHub are the primary sources; zip install is a fallback, not the first option.
- GitHub stays "paste a repo URL"; no GitHub browsing.
- Loaders come into scope as "all common loaders"; this project covers BepInEx 5/6 (Mono/IL2CPP), project 2 MelonLoader and UE4SS.
- Order: custom games first, then more loaders, then Nexus dependencies.
- Work like r2modman: Steam launches stay vanilla and mods load only when launched through HML. HML doesn't import hand-installed loaders or mods; if one exists in the game folder, HML prompts to remove it in favor of HML managing it.

## Calls made by the designer (the user can override)

- Un-added installed Steam games show only when searched, not in the default game list.
- Loader is installed from `BepInEx/BepInEx` GitHub releases as a GitHub mod (auto-updating), rather than bundling BepInEx or using Thunderstore's BepInExPack.
- BepInEx 5 choice never auto-updates to 6.
- "No loader" custom games use the existing deploy model.
- **Changing a game's loader later** changes what new profiles get. Existing profiles are not migrated automatically; a profile whose installed loader doesn't match the game's choice shows a one-click "Switch to <loader>" action that uninstalls the old loader mod and installs the new one (mods are left as they are).
- **Native Linux builds.** If the game folder has no Windows `.exe` (a native Linux build, e.g. an `.x86_64` binary), the add dialog says BepInEx needs the Windows version through Proton ("Force Proton in the game's Steam properties, then add it again") and offers only "No loader". Trash Day on the user's machine is a Windows build run through Proton (`Trash.exe`, `MonoBleedingEdge`), so it detects as Unity Mono → BepInEx 5.
- **BepInEx 6 source.** GitHub releases only for now (its newest 6.x pre-release). Newer IL2CPP games may need the bleeding-edge builds from builds.bepinex.dev; supporting that source is deferred, and the IL2CPP choice's label says it uses the GitHub pre-release.
- **Importing a profile for a folder-added game** the importer doesn't have: the import asks the user to pick the game's folder and adds it as a custom game (with the exported loader choice), instead of refusing. Matching uses the display name, which is editable from the game's menu.
- **Removing a custom game** removes it from HML's game list and clears its settings (path override, Nexus domain override, last profile). Its profiles stay on disk; re-adding the same game (same Steam app id, or same label for folder games) picks them back up. Custom-game labels are stable: `steam-<appid>` for Steam games, a slug of the folder name for folder games.

- **Folder-added (non-Steam) games launch** with HML's normal modded and vanilla buttons on every platform. On Windows HML runs the game's exe directly with the same doorstop files and arguments as a Steam launch. On Linux HML runs the exe through a runner chosen per game: a Proton version found in the user's Steam libraries (default: the newest one installed) or the system Wine (default when no Proton is found). Proton runs use an HML-owned prefix per game in HML's data directory; both runners set `WINEDLLOVERRIDES="winhttp=n,b"` so doorstop loads. The runner is shown in the add dialog and can be changed from the game's menu. If neither Proton nor Wine is found, the launch buttons explain what to install.
- **Manual-install removal is a move to a backup folder**, not a delete, so the user's hand-installed plugins and configs are recoverable.

## Left to the builder

- How to make the doorstop files left in the game folder inert for plain Steam launches (goal 8): for example write a `doorstop_config.ini` with doorstop disabled, relying on the launch arguments to enable it, or remove the copied files when the game exits. Verify with both doorstop 3 and 4.

- Exact Steam tool filter list (by app id and/or name pattern), provided the anti-goal holds.
- Where the custom-games file lives and its schema (follow `nexus-added-games.json`).
- Game card art for Steam games (Steam's library capsule image by app id is fine; fall back to initials like today).
- Dialog layout for loader choice, following existing dialog components.
