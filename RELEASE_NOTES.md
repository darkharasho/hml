# Release Notes

Version v1.2.0 — October 17, 2026

## Edit mod configs in HML
A new Config tab lists your profile's config files. BepInEx configs open as a proper form with toggles, dropdowns, sliders and a Reset to default for each setting, or switch to raw text if you'd rather. Mods with a config also get "Edit config…" in their menu.

Saving only changes the values you touched, so the file's comments and layout stay as they were.

## Log viewer
The new Log tab follows your mod loader's log live while the game runs. Filter to just problems or errors, search, and expand stack traces when you need them. Errors are traced back to the mod that logged them, with a quick "Problems by mod" summary up top so you can see what's breaking.

## Update notifications
HML now checks all your profiles for mod updates in the background, shortly after launch and every 6 hours. Game cards and profiles show how many updates are waiting, and you get a system notification when new ones turn up. Click it to jump to the profile.

NOTE: Don't want the pings? Turn off "Update notifications" in Settings.

## Pick a version, roll back and hold
- Hold a Thunderstore or Nexus mod at its current version and update checks leave it alone.
- Installing an older Thunderstore version holds it there automatically. Installing the newest frees it again.
- GitHub mods get "Change version…", which lists their releases so you can roll back. Pick the newest release to turn updates back on.

## Smarter disable and uninstall
- Turning off a mod that other mods need asks whether to turn those off too, and turning a mod on also turns on anything it needs.
- Uninstalling warns you about mods that depend on it, and offers to remove dependencies nothing else uses.

## QoL Improvements
- Duplicate a profile from its menu. You get a full copy of its mods, configs and files to experiment with.
- Importing a profile now shows each mod's icon and description, so you can see what you're getting before you hit Import.
