# discord-claude

> Discord Rich Presence for [Claude Code](https://claude.com/claude-code) — show what you're building, live. Like [discord-vscode](https://github.com/iCrawl/discord-vscode), but for your agent.

```
🟢 your-name
   Playing Clawd Code
   ┌─────────────────────────────────┐
   │ ▟█▙  In my-cool-project         │
   │ ███  Editing daemon.ts          │
   │      00:42 elapsed              │
   └─────────────────────────────────┘
```

Your Discord status updates in real time as Claude works:

| Activity | Presence |
| --- | --- |
| You send a prompt | `Thinking…` |
| Claude edits or writes a file | `Editing daemon.ts` |
| Claude reads a file | `Reading config.json` |
| Shell commands | `Running: Install dependencies` |
| Codebase search | `Searching the codebase` |
| Web research | `Browsing the web` |
| Claude finishes a turn | `Waiting for the next prompt` |
| Permission dialog open | `Waiting for approval` |
| No activity for 5 min | `Idle` |

…plus the project name, elapsed session time, and the model (Opus, Sonnet, …) in the icon tooltip.

## Why it's not "just an extension"

VS Code has an extension API; Claude Code has **[hooks](https://code.claude.com/docs/en/hooks)** — commands that fire on lifecycle events. Rich Presence needs a *persistent* connection to Discord, and hooks are short-lived processes, so this project bridges the two:

```
Claude Code ──hooks──▶ hook.ts ──local socket──▶ daemon.ts ──▶ Discord IPC
            (async,    (forwards one             (persistent;   (discord-ipc-0)
             0 latency) JSON line)                self-starting,
                                                  self-stopping)
```

- Hooks are registered `async`, so they add **zero latency** to Claude Code.
- The daemon starts on the first event and exits ~45 s after your last session ends.
- Multiple concurrent sessions are supported — presence follows the most recently active one.
- Updates are throttled to respect Discord's rate limit (5 / 20 s).
- **Zero runtime dependencies.** The Discord IPC protocol is ~150 lines in [`src/ipc.ts`](src/ipc.ts).

## Install

Requirements: [Node.js](https://nodejs.org) 18+, the Discord **desktop** app, and Claude Code.

```sh
git clone https://github.com/YOUR_USERNAME/discord-claude.git
cd discord-claude
npm install
npm run setup
```

`npm run setup` builds the TypeScript and registers the hooks in `~/.claude/settings.json` (user-level, all projects; a timestamped backup is made first). Then start a **new** Claude Code session — hooks load at session start.

### Using your own Discord application (optional)

Out of the box this uses a shared Discord application, so it just works. If you want your own "Playing …" name and icon:

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**. Note: Discord rejects names containing trademarks like "Claude" — get creative ("Clawd Code", "CC", …).
2. Copy the **Application ID** from *General Information*.
3. `node dist/install.js <your-application-id>`

## Configuration

`config.json` (created on install, gitignored) — changes apply live, no restart needed:

| Key | Default | Meaning |
| --- | --- | --- |
| `clientId` | shared app | Discord application ID to publish under |
| `showProjectName` | `true` | Show the project folder name |
| `showFileNames` | `true` | Show file names being read/edited |
| `showToolDetail` | `true` | Show command descriptions / skill names |
| `largeImage` | Claude logo | Image URL, or an asset key uploaded to your app |
| `largeText` | `Claude Code` | Tooltip on the large image (model gets appended) |
| `smallImageWorking` / `smallImageIdle` | `""` | Optional corner badge (URL or asset key) |
| `activityType` | `0` | 0 Playing · 2 Listening · 3 Watching · 5 Competing |
| `buttons` | `[]` | Up to 2 `{ "label", "url" }` buttons |
| `idleTimeoutMs` | `300000` | Quiet time before showing `Idle` |
| `presenceHeartbeatMs` | `15000` | Resend unchanged presence to nudge Discord UI refreshes; set `0` to disable |
| `debug` | `false` | Verbose logging |

## Privacy

Only the rendered status line ever reaches Discord — never prompt text, file contents, or command output. The hook forwards event names, file *basenames*, and short tool descriptions to a daemon on your machine, and nothing else. Set `showFileNames` / `showProjectName` / `showToolDetail` to `false` for stealth mode.

Anyone who can see your Discord activity can see what the presence shows — keep that in mind for client work.

## Troubleshooting

- `npm run status` — what the daemon thinks is happening
- Log file: `<tmpdir>/claude-discord-rpc.log` (set `"debug": true` for the full play-by-play)
- **Nothing shows up?**
  - Discord Settings → **Activity Privacy** → enable *Display current activity as a status message*
  - The Discord **desktop app** must be running (the browser version has no IPC socket)
  - `Invalid Client ID` in the log → bad `clientId` in config.json
- **Buttons don't show for you?** Discord never shows you your own buttons — ask a friend.
- Moved the folder? Re-run `npm run setup` so the hooks point at the new path.

## Uninstall

```sh
npm run uninstall-hooks
```

Removes the hooks (with a settings backup) and stops the daemon.

## License

[MIT](LICENSE) — inspired by [iCrawl/discord-vscode](https://github.com/iCrawl/discord-vscode).
