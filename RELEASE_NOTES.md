# Release Notes

Version v1.4.0 — October 19, 2026

## Synced profiles
Keep a group of friends on the same mods without passing new share codes around. In the Share dialog, pick **Create sync code** and send that code to your friends once. After that, every change you make to the profile reaches them automatically: added, removed, enabled or disabled mods, version changes, and config edits.

- **For the owner:** the profile works as normal. Changes publish about 10 seconds after you stop editing, and only when something actually changed, so launching the game doesn't send out updates. The profile shows a "Syncing" badge, and **Stop syncing** ends the code for everyone.
- **For friends:** importing a sync code creates a synced copy of the profile. HML checks for updates on startup, every 5 minutes while it's open, and right before a modded launch. Updates apply automatically with a toast like "Squad updated: +1 mod, 1 disabled". If the game is running, the update waits until it closes.
- **Your own config tweaks stay.** Friends can still change settings like keybinds or FOV. An update only changes the settings the owner changed, and the owner's value wins when you both changed the same one.
- **Synced profiles are read-only for friends.** Mods can't be added, removed, toggled or updated there, and HML's own update checks skip them, so nobody drifts onto a different version. Launching, configs and the profile folder all still work. **Detach from sync** turns it back into a normal profile.
- Nexus mods that need a manual download stay listed on the profile with a button to open their Nexus page. Mods installed from a local file don't sync.

Sync codes only work in HML 1.4.0 and later, so everyone in the group needs to update.
