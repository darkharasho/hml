# Synced profiles

## Intent

The user plays modded games with a group of friends. Today, whenever the user changes their profile, either everyone imports a fresh share code or everyone repeats the change by hand, even for something as small as disabling one mod. Synced profiles remove that chore: the user shares a **sync code** once, and from then on every change the user makes to that profile (add, remove, enable, disable, mod version changes, config edits) reaches every friend who imported it, with no action on their side.

Success: the user creates a sync code for their "Squad" R.E.P.O. profile and posts it in Discord. Three friends import it once. Weeks later the user disables a mod and adds another. Each friend's HML picks that up the next time they open HML (or within a few minutes if it's already open), applies it, and shows "Squad updated: +1 mod, 1 disabled". They hit Play and are on the same mod set as the user.

## Roles

- **Owner:** the person who created the sync code. Only the owner can change the synced profile. The owner's profile works exactly like a normal profile; edits publish automatically.
- **Follower:** anyone who imported the sync code. Their copy is a read-only mirror of the owner's mod list, except that they can edit config files locally (see Config merge).

## Goals

1. **Create a sync code.** From a profile's share menu, next to the existing share-code and export options, the owner picks "Create sync code". HML publishes the profile and shows a code to copy. This code is visibly different from a one-off share code, so nobody confuses them. The profile then shows a "Syncing" badge and a menu entry "Stop syncing".
   - A profile has at most one sync code. Creating one again shows the existing code.
   - Before creating the code, and whenever the owner adds one, HML flags mods friends can't receive: local (file-installed) mods. They show a "won't sync to friends" marker on the owner's side. The rest of the profile still syncs.
2. **Owner edits publish automatically.** Any change to the synced profile's mod list (install, uninstall, enable, disable, version change, including GitHub auto-updates and Thunderstore/Nexus updates the owner accepts) or its config files publishes a new revision. Publishing is debounced: HML publishes once changes have settled for about 10 seconds (my call; the builder may tune it). It never publishes when nothing changed, compared by content (games rewrite their config files on every run, so a run alone must not produce a revision unless a value actually changed).
   - If a publish fails (offline, rate-limited), HML retries later and shows a small, non-blocking "Sync pending" state on the owner's badge. It doesn't nag.
3. **Import a sync code.** The existing Import dialog accepts sync codes as well as share codes, and HML tells them apart. Importing a sync code creates a new follower profile built the same way a share-code import is today (same game resolution, custom-game handling and installers), and marks it as synced to that code.
   - Importing a sync code you already follow switches to that profile instead of making a second copy.
   - The owner importing their own code: same, switch to the owned profile.
4. **Followers stay current.** A follower's HML checks each synced profile for a newer revision:
   - when HML starts,
   - every few minutes while HML is open (5 minutes, my call),
   - right before launching that profile modded. If an update is found then, it is applied first, then the game launches.

   Checks are cheap: the client asks "anything newer than revision N?" and the Worker answers without sending the profile when there isn't.
5. **Updates apply silently, with a toast.** A newer revision is applied without a prompt: mods are installed, removed, enabled, disabled, and moved to the owner's exact versions; config changes are merged (goal 6). Then a toast summarizes it, e.g. "Squad updated: +2 mods, 1 removed, 1 disabled, configs changed". The toast names the profile. HML has no user display names, so it says "Squad updated", not "updated by Harasho".
   - **Game running:** if the follower's game is running from that profile, the update waits until the game exits, then applies.
   - **Partial failure:** if some downloads fail, everything that can apply does, and the profile records that it is behind. The next check retries the rest.
   - **Nexus mods:** Nexus mods install as far as the follower's Nexus login allows. Where a manual download is needed (free accounts), the rest of the update still applies and the toast says "1 mod needs a manual download", with a button that opens the right Nexus file page through the existing Nexus manual-download flow.
   - **Local mods** in the owner's profile are skipped on the follower's side.
6. **Config merge, per setting, owner wins on conflict.** Followers can edit configs in their synced profile (for example their own keybinds or FOV), and those edits survive updates:
   - For each config file the follower keeps the owner's last-applied version as a **base**. When a new revision arrives, each setting the owner changed since the base (owner's new value ≠ base value) is written into the follower's file. Every other setting keeps the follower's current value. When owner and follower both changed the same setting, the owner's value wins.
   - Settings the owner added are added. Settings the owner removed are removed.
   - Formats parsed per setting: BepInEx `.cfg`, `.ini`, `.toml` (MelonLoader), `.json`. Any other file the owner changed is replaced whole.
   - A config file the owner deleted is left alone on the follower's side. A follower's config files the owner never had are left alone.
   - Which files count as configs is the same set share codes already carry (`CONFIG_PREFIXES` and the UserData extension list in `hmlFile.ts`).
7. **Follower profile is locked.** On a follower profile, adding, removing, enabling, disabling, and updating mods are disabled. A "Synced" badge explains why. HML's own update checks (GitHub auto-update, Thunderstore and Nexus update prompts) skip follower profiles, because versions come from the owner. Launching (modded and vanilla), opening the config editor and the profile folder, and viewing mods all still work.
8. **Leaving and ending a sync.**
   - **Follower detaches:** "Detach from sync" turns the follower profile into a normal profile, unlocked, with its current mods and configs. It stops checking.
   - **Owner stops syncing:** "Stop syncing" ends the code on the server. Followers learn of it on their next check, get a toast ("Squad is no longer synced"), and their profile is detached the same way, keeping its last state.
   - **Owner deletes the profile:** HML asks whether to stop syncing for friends too. The default is yes.
9. **Owner key.** Creating a sync code gives the owner's HML a secret key that authorizes publishing to it. The key lives only on that machine (stored alongside HML's other secrets, `src/main/secrets.ts`). Losing it (reinstall, new PC) means the owner can no longer publish to that code; they'd create a new one. Exporting the owner key is a possible later addition, not part of this work.

## How it's built (decided)

- **Transport:** extend the existing `hml-share` Cloudflare Worker (`worker/`) and its KV namespace. No new service. The project's "no backend service" non-goal is bent knowingly: the Worker already exists for share codes.
- **Payload:** each revision is a `.hml` file, the same format share codes upload (`export.json` plus configs, `hmlFile.ts`), so building a revision and applying a fresh import reuse existing code.
- **Server shape** (routes are the builder's call; the behaviour isn't):
  - Create: the client uploads the first revision, and the server returns a new sync code and an owner key. The server stores only a hash of the key.
  - Publish: the client uploads a new revision with the owner key. The server checks the key and stores it as revision N+1. Requests without a valid key are refused.
  - Check/fetch: anyone with the code can ask for the latest revision, conditional on the revision they already have (unchanged → a tiny response with no body). Responses must not be cached as immutable the way share-code downloads are (`cache-control: immutable` today).
  - Stop: the owner key ends the sync. The code then answers "ended" (distinct from "not found") for at least as long as a follower might still check, so followers can tell the owner stopped rather than the code being mistyped.
  - Expiry: a sync that hasn't been published to for a year may expire, like share codes. Each publish refreshes it.
  - **Free tier (the user's decision).** The Worker stays on Cloudflare's free plan, which shares roughly 100k requests/day and 1k KV writes/day across the account with share codes. "Anything newer?" checks must be cheap. They must not read the full revision from KV, and ideally they don't touch KV at all. Keep the latest revision number somewhere cheap (edge cache, or a small Durable Object per sync code; the builder picks). Owner publishes are the only KV writes. The design should make moving to Workers Paid a config change, not a rewrite.
  - Rate limits like the existing ones, sized so a group of followers polling every 5 minutes and an owner's debounced publishes stay comfortably inside them. Mind KV's write limits; debouncing exists partly for that.
- **Follower state** stored on the profile: sync code, last applied revision, "behind" flag, and per-config-file base copies for the merge.
- **Owner state** stored on the profile: sync code, last published revision, plus the owner key in secrets.

## Calls made while writing this up (check these)

- **"Game running" means any copy of the game's exe running**, as far as HML can detect it (`src/main/launch/processes.ts`), on any OS where it can tell. HML can't tell which profile a game was launched from, so it holds the update for any running copy. Where HML can't detect it at all, the update applies anyway. Applying only touches the follower's profile folder. Deploying into the game folder happens at the next launch, as it does today.
- **No secure storage on the owner's machine** (e.g. Linux without a keyring): creating a sync code is refused with the same "no secure storage" message GitHub and Nexus tokens use. The owner key is never stored in a weaker way.
- **Older HML versions:** sync codes are a format older clients reject as an invalid code, so old clients fail cleanly. Revisions carry the `.hml` format version, and a client that can't read a revision says "Update HML to keep following this profile" instead of failing silently.

## Non-goals

- Followers keeping their own extra mods, or their own enable/disable choices, on a synced profile.
- More than one owner, handing ownership to someone else, or publishing from a second machine.
- Live updates while a game is running.
- Syncing anything outside the profile (game installs, loader settings outside the profile folder, HML settings).
- Accounts, logins, or friend lists. The code is the only identity.

## Anti-goals (would be a failure even if it works)

- A friend's personal config tweaks (keybinds, FOV, volume) get wiped by an update to a setting the owner didn't touch.
- Mods change under a running game.
- Followers drift: their own HML auto-updates a mod to a version the owner doesn't have.
- The owner spams revisions (and friends get toasts) just from launching the game, because configs got rewritten with the same values.
- Someone with only the sync code can push changes.

## Left to the builder

- Sync code format and how it's told apart from share codes, as long as users can't confuse the two.
- Exact routes, KV key layout, revision storage (latest only is fine; history isn't required).
- Debounce and poll intervals within the spirit of the numbers above.
- Merge details per format (comments, ordering, BepInEx section/key handling), as long as untouched settings and the follower's formatting survive where practical.
- UI placement and copy for badges, menus and toasts, following the existing ShareDialog / ImportDialog / ProfileSidebar patterns.
