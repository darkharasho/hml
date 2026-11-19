# Release Notes

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
