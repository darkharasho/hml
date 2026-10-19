# Release Notes

Version v1.3.0 — October 18, 2026

## More games, more mod loaders
HML now handles four more mod loaders, the same way r2modman does, so a lot more Thunderstore games work:
- **MelonLoader** games such as Schedule I. MelonLoader settings in `UserData` travel with share codes too.
- **lovely** for Balatro.
- **Return of Modding** for Hades II and Risk of Rain Returns. Its config is included in share codes.
- **Godot Mod Loader** for Brotato, Dome Keeper, Pair A Dice and RAM: Random Access Mayhem. These games ship the loader themselves, so HML doesn't copy anything into the game folder, and Brotato's native Linux build can launch modded.

The Log tab follows MelonLoader, lovely and Return of Modding logs while the game runs.

## New mods and updates show up in minutes
No more waiting an hour or more for a mod that's already live on Thunderstore. HML now checks Thunderstore's live listing every couple of minutes, so new mods and updates appear almost as soon as they're published.

## Fixes
- Fixed BepInEx mods never loading in games that keep their exe in a subfolder of the Steam install, such as Chrono Ark and Outward. Those games also no longer get a false "native Linux build" warning on Proton.
