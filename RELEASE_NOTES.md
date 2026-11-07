# Release Notes

Version v1.8.0 — November 6, 2026

## Several mods from one GitHub repo
Some authors keep all their mods in one repo and tag each release with the mod's name, like `infinite-energy-v0.1.0`. HML now treats each of those as its own mod:
- Paste the repo link and HML asks which mod you want. Paste a release link and it installs that mod.
- Updates only come from that mod's own releases, so another mod shipping from the same repo is no longer offered as an update.
- You can install several mods from the same repo in one profile. Before, installing a second one replaced the first.

## Works with sync and share codes
Synced profiles and share codes now keep every mod from a repo like this, and a follower only updates the mod whose release changed.

NOTE: A release link to a mod's newest release keeps it updated. A link to an older release holds it at that version, same as before.
