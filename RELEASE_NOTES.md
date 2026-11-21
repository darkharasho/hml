# Release Notes

Version v1.9.8 — November 20, 2026

## Fixes
- Nexus files you download from their page in HML's Nexus window (mods whose author turned off Mod Manager Download) now install without a Nexus Mods API key. Mod Manager Download, Install and Update still need one.

Version v1.9.7 — November 20, 2026

## Fixes
- BepInEx installed from Nexus Mods now loads under Proton. Starting a game with BepInEx deployed sets Proton to load BepInEx's winhttp.dll from the game folder, so mods run without Steam launch options.
- A Nexus mod whose download is just a plugin DLL (and maybe a readme) now installs into BepInEx/plugins, where BepInEx loads it, instead of the game folder. Reinstall a mod like this you installed before 1.9.7 to move it.

Version v1.9.6 — November 18, 2026

## Nexus games start like any other game
Games added from Nexus Mods that HML finds through Steam (Invokyr, for example) now have Start vanilla and Start modded, like Thunderstore games. Start modded copies the profile's mods into the game folder and starts the game. Start vanilla takes HML's mods out first. HML finds the game folder through Steam, so there's nothing to set up. Deploy mods and Remove mods only appear for games HML can't start or can't find.

## Nexus mods to install, in the mod list
Nexus mods waiting to be installed now appear as dashed rows in the profile's mod list, not in a separate box. A profile whose only mods are waiting ones no longer shows the "Browse mods" page.

## Fixes
- Picking a Nexus game from the home page keeps its Steam cover on the game page.
- Profile names are unique. Importing or creating a profile with a name already in use adds " (2)", " (3)" and so on.

Version v1.9.5 — November 18, 2026

## Nexus mods to install, listed in the profile
When an imported profile has Nexus mods that a free account has to download from their pages, HML now lists them at the top of the profile's Installed tab. Click Install, or Install all, and HML's Nexus Mods window opens each file page. Click "Mod Manager Download" and HML installs the file into that profile; the mod then leaves the list. The list stays with the profile until each mod is installed, and ✕ removes one you don't want. Mods skipped because no Nexus API key was set are listed too.

The import result now offers "Install N Nexus mods" to start right away, or Later. Synced profiles you follow show their manual downloads in the same list.

Version v1.9.4 — November 18, 2026

## Play deploys your mods
For games where HML copies mods into the game folder, Play now deploys the current profile first and then starts the game. Switching profiles, or turning mods on and off, no longer needs a separate Deploy before playing. If the deploy fails, HML shows the error and doesn't start the game. Deploy mods and Remove mods are still there.

## Fixes
- Steam games added from Nexus Mods (Invokyr, for example) show their cover and get a Play button once HML finds them installed through Steam.

Version v1.9.3 — November 17, 2026

## Mods with manual downloads only
Some Nexus Mods authors turn off "Mod Manager Download", so their pages only offer the file itself. Downloading one in HML's Nexus window used to save the zip to your Downloads folder and nothing else. Now HML installs it right away, just like a mod manager download, and moves on to the next page.

## Fixes
- Downloads from HML's Nexus window install into the profile you opened them from, even if you switch to another profile before you finish. This matters most for a synced profile's manual downloads.
