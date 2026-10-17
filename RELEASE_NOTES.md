# Release Notes

Version v1.1.0 — October 16, 2026

## Mod READMEs
Opening a Thunderstore mod now shows its README and changelog, rendered like the mod page, next to its dependencies. Clicking a link in them opens it in your browser.

## No more Steam launch options on Linux
On Proton games, HML no longer asks you to paste launch options or close Steam. Start modded now sets up the game's Proton prefix so BepInEx loads by itself. The first change keeps a backup of the file it edits (`user.reg.hml-backup`).

NOTE: Proton creates a game's prefix the first time the game runs. For a game you've never started, HML asks you to start it once (vanilla is fine) before mods can load.

NOTE: Launch options HML set for you before still work and do no harm. You can clear them in Steam if you like.
