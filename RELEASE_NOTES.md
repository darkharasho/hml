# Release Notes

Version v1.6.0 — November 5, 2026

## See how far along a synced profile is
If you follow someone's synced profile, its badge now shows how many of their mods you have, like **Synced 24/24**. It turns amber when you're short (**Synced 23/24**), and hovering over it names the mods you're missing. The owner's local mods can't sync, so the tooltip lists them separately.

While an update installs, the badge counts up (**Syncing 7/24**) and shows which mod it's on. If the game is running, it shows **Waiting for game** until you close it, because HML doesn't change mods under a running game.

## Sync now
The profile's ⋯ menu has a new **Sync now** item for followers. It fetches the owner's latest list right away and installs anything you're missing, even if nothing changed. Afterwards it tells you the result, for example "Up to date: 24/24 mods" or which mods are still missing.

If you own the profile, the menu item is **Publish now**. It sends your changes right away and tells you how many mods your friends will get.

## Fixes
- A follower who ends up missing a synced mod now retries automatically. Before, it only retried when an install reported an error.

NOTE: The counts appear after the owner's next change or after you press Sync now. Everyone following a profile needs v1.6.0 to see them.
