# Release Notes

Version v1.5.0 — November 4, 2026

## The hml command
HML now has a command line, so you or an AI agent writing a mod can put a build into a profile the same way HML installs any other mod, instead of copying files into the game folder. Install it from **Settings → Command line**, then try `hml help`.

- `hml install <game> <folder or zip> --profile Dev` installs a build. Installing it again replaces the previous one, and your config files stay.
- `hml mods`, `enable`, `disable`, `uninstall`, `new-profile` and `launch` cover the rest. Add `--json` for output a script can read.
- If HML is open, commands run inside it and the window refreshes with a toast. If it's closed, they run without opening a window.

## Getting an agent to use it
Click **Copy agent instructions** in the same Settings section and paste the text into your agent's `CLAUDE.md` or `AGENTS.md`. It tells the agent to install each build into a Dev profile with `hml` rather than touching the game folder.

NOTE: On Linux the command points at the AppImage, so reinstall it from Settings if you move the AppImage. On Windows it goes in `%LOCALAPPDATA%\Microsoft\WindowsApps`, which is on your PATH by default.
