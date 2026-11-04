/** Instructions to paste into an AI agent's standing context (CLAUDE.md, AGENTS.md, …). */
export const CLI_AGENT_INSTRUCTIONS = `## Testing mods in HML
Install mod builds into HML (my mod manager) with the \`hml\` command. Don't copy files into game or mod loader folders.
- First time in a game: \`hml games\` to find the game id, then \`hml new-profile <game> "Dev"\` if \`hml profiles <game>\` has no Dev profile.
- After each build: \`hml install <game> <package zip or build folder> --profile Dev\`. Installing again replaces the previous build.
- Prefer a Thunderstore-style package zip or folder with a manifest.json at its root; without one the folder name becomes the mod id.
- Check with \`hml mods <game> --profile Dev --json\`. Start the game with \`hml launch <game> --profile Dev\` only when I ask.
- Exit code 0 means success; 1 means the operation failed and 2 means wrong usage. \`hml help\` lists everything.
- If \`hml\` isn't found, tell me to install it from HML's Settings → Command line instead of falling back to copying files.
`
