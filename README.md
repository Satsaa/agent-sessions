# Agent Sessions

A VS Code sidebar that lists your **Claude Code** and **Codex** sessions together, shows which ones are working, waiting for you or stopped, and opens any of them as a normal editor tab. Built for people who run several agents at once, often in git worktrees, and want one place to see them.

## What it shows

**Sessions view** — every session from `~/.claude` and `~/.codex`, newest first, grouped by activity (Active / History) by default.

| Icon | State | Meaning |
| --- | --- | --- |
| spinning sync (green) | Working | the agent is doing things right now |
| bell (orange) | Needs your input | it stopped on a permission prompt or a question |
| speech bubbles (blue) | Replied | it finished its turn and its process is alive, waiting for your next message |
| grey Claude / Codex mark | Stopped | no process holds the session; it is history |

Each row's description shows the tool, the **worktree** it runs in (nothing for the main checkout — the tooltip has the branch) and how long ago it was touched. A worktree row also carries `↑N ↓N` commits ahead/behind its upstream (or the main checkout when the branch has no upstream) and `+I −D` lines changed across staged, unstaged and untracked files (compacted to `1.5k`, `2m`), each omitted when zero and refreshed with the list. The tooltip has the worktree path, branch, the directory the session was started in, PID and session id.

Worktrees are detected from what the agent actually did, not from where it was launched — sessions usually start in the repository and move into a worktree later:

- Claude Code writes a `worktree-state` record into the transcript when a session enters or leaves a worktree (`EnterWorktree` / `ExitWorktree`, `claude -w`); the latest one wins. Without one, the shell's most recent recorded cwd decides.
- Codex records a thread's cwd once and never moves it, so the rollout's tool calls are scanned for the last `workdir`, `cd` or `git -C` directory; a directory inside a linked worktree names it.

**Worktrees view** (collapsed by default) — every git worktree of the repositories in play: the workspace's repos plus any repo a live or recent session ran in, the main checkout included. Each row shows the branch, `↑ahead ↓behind` its base and `+I −D` lines changed (zeros omitted; the tooltip has the staged/unstaged/untracked breakdown); expanding it shows the agents bound to that worktree — live ones first, then the last few stopped sessions — as ordinary session rows that open on click. A worktree with a live agent takes that agent's state icon. The base is the branch's upstream when it has one, else the remote's default branch, else the main checkout's HEAD (detached promotion checkouts land there, so their counts are large by nature). Right-click a worktree to open it in a new window, open a terminal there, copy its path, or start a Claude / Codex session in it. **Delete Worktree** (trash button or right-click) calls the same built-in Git command as Source Control’s Repositories → worktree → Delete action, including its modified/untracked-file confirmation. The main checkout has no delete action.

**Usage view** — subscription limits for both accounts (Claude shows its plan and Max tier, Codex its plan tier — `pro` is Pro 20x, `prolite` Pro 5x — and renewal date read from the login token; a Luna Reserve allowance, when the account has one, is its own row), each window shown as **percent left** (100% is a fresh window, 0% exhausted) with the original ten-segment inline bar: only the bar is tinted green, orange under 20% left, or red under 10%; labels, percentages and reset times stay neutral. The status bar item takes the colour of the tightest window.

- **Claude**: session (5h) and weekly windows, plus any model-specific or extra-usage limits your plan reports, with reset times. Fetched from Anthropic's OAuth usage endpoint with the credential Claude Code already stores locally (the same call the CLI makes for `/usage`). Windows on the same host share a cache and request lock. A 429 honors `Retry-After` and backs off from five minutes to an hour, keeping the last successful counts and plan visible in both the Usage view and status bar. A warning icon appears once the reading is more than ten minutes old; retry errors stay in the tooltip. Refresh clicks also respect the cooldown. Can be turned off with `agentSessions.usage.claudeNetwork`.
- **Codex**: fetched live from the chatgpt.com usage endpoint the Codex CLI's `/status` and the IDE plugin read, with the login stored in `~/.codex/auth.json` — weekly window, any model reserve limits, credits. Codex keeps that token fresh while it runs; if it has gone stale, or `agentSessions.usage.codexNetwork` is off, the numbers come from the rate-limit snapshot Codex writes into every rollout's `token_count` event, as fresh as your last Codex turn. Switching account refetches immediately.

Two status bar items mirror this: working / waiting / replied counts on the left, usage percentages on the right. The Sessions view carries a badge with the number of sessions waiting for input.

## Actions

- **View: Show Agent Sessions** opens the sidebar from the command palette (VS Code files it under *View*, not *Agent Sessions*; the built-in view of the same name is a different entry); **Agent Sessions: Show Sessions** and **Agent Sessions: Show Worktrees** focus one view.
- **Click a session** to open it. Claude sessions open in a Claude Code tab in the *active* editor group (not a new locked group). Codex threads open in the Codex conversation editor. If a session is already open, its tab is revealed.
- **Rename Session** (pencil on each row, right-click, or **F2** on the selected row). A Claude session that is open in a tab is handed to Claude Code's own rename, which prompts, stores the title and relabels the tab. Otherwise the title is written the way the tools' `/rename` does — Claude: `<id>/custom-title.json` beside the transcript plus a `custom-title` record in it; Codex: `threads.title` in the state database plus a `thread_name` line in `session_index.jsonl` — so the tool and this view agree on the name. An open Codex tab keeps its old label until the thread is reopened; nothing outside the Codex extension can relabel it.
- **Pin / Unpin Session** keeps a session at the top of Active even after it stops. Pins persist across reloads, appear in both session lists, and keep the real status icon. Repository, archive and subagent filters still apply.
- **New Claude / New Codex** buttons in the view title start a fresh session, again as a tab.
- **Close Codex Session…** (× on each Codex row, also in the right-click menu) releases a stuck local session on Linux, including Remote-SSH and WSL. It asks before stopping the Codex process and lists **all sessions that process holds**, since one app-server can own several. Active work in those sessions is interrupted; saved conversations remain available to reopen. The original window may need a reload to reconnect Codex.
- **Switch Codex Account…** (account icon in the Usage view title, also in the Sessions view menu) moves Codex between several ChatGPT logins on one machine. It lists every login found under the Codex home — the active `auth.json`, profiles it saved under `auth-profiles/` and any `auth-backup.*` copy — one entry per account with email and plan. Switching first saves the current login as a profile (so its refreshed tokens are kept), then, on Linux, asks to stop every running Codex process, because each one keeps the login it started with and holds its sessions locked until it exits, and finally offers **Reload Window**, since the Codex extension reads the login when the window starts. *Add another account…* saves the current login and runs `codex logout; codex login` in a terminal; the new login shows up in the list once it exists. The Usage tooltip names the active account.
- Right-click: Resume in Terminal (`claude --resume` / `codex resume` in the session's cwd), Copy Resume Command, Open Transcript File, Open Working Directory in New Window, Archive / Unarchive.
- View menu: show/hide archived sessions, show/hide subagent threads, only this repository (worktrees of the workspace's repo included), group by Activity / Repository / Tool / None.

Claude Code resumes only sessions started in the window's first folder, so opening a Claude session from another folder hands it to a window on that folder, which opens it: a new window, or the one already open there. Codex sessions open in any window. If the Claude Code or Codex extension is not installed, opening falls back to a terminal.

## Filtering defaults

- **Archived** sessions are hidden. Codex's own archive flag is honoured; sessions archived or pinned from this view are kept in `~/.agent-sessions/state.json`, shared live by every window running as the same user (desktop remote windows and the phone server alike). Marks from earlier versions move there on first start.
- **Subagent threads** (Codex threads spawned by another thread) are hidden.
- **Empty** stopped sessions where no prompt was ever sent are hidden.
- History is capped at 200 sessions (`agentSessions.historyLimit`).

## How it reads state

Session discovery is read-only. The explicit Close and Switch Account actions send SIGTERM to verified Codex lock owners, and Switch Account rewrites `~/.codex/auth.json` from a saved copy (mode 600, written via rename); nothing deletes lock files, transcripts or database rows:

- Claude live status comes from `~/.claude/sessions/<pid>.json` (busy / waiting / idle) after checking the PID is alive; titles from the transcript's `custom-title` / `ai-title` records or the first prompt; cwd and branch from the transcript.
- Codex threads come from `state_*.sqlite` via `node:sqlite` (read-only), turn status from `thread_history_*.sqlite`, liveness from `thread-writer-locks/` (on Linux, only locks actually held by a Codex process count; leftover unlocked files are ignored). On a host without `node:sqlite` it falls back to scanning the rollout files.
- Directories are watched with `fs.watch` and the list refreshes on change; while any session is live it also polls every few seconds, because a process can die without touching a file.

## Install

Not on the marketplace. Download the `.vsix` from [Releases](https://github.com/Satsaa/agent-sessions/releases) and:

```
code --install-extension agent-sessions-<version>.vsix
```

Over Remote-SSH, install it on the remote (the extension is `workspace`-kind, since that is where the session files live). Inside VS Code's integrated terminal on the remote, `code` is the remote CLI and does the right thing.

## Build

```
pnpm install
pnpm build        # dist/extension.cjs
pnpm typecheck
pnpm test
pnpm package      # agent-sessions-<version>.vsix
```

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `agentSessions.tools` | `["claude","codex"]` | which tools to list |
| `agentSessions.groupBy` | `activity` | `activity`, `repository`, `tool` or `none` |
| `agentSessions.scope` | `all` | `workspace` limits to the current repo and its worktrees |
| `agentSessions.showArchived` | `false` | |
| `agentSessions.showSubagents` | `false` | |
| `agentSessions.showEmpty` | `false` | stopped sessions with no prompt |
| `agentSessions.historyLimit` | `200` | |
| `agentSessions.pollInterval` | `5` | seconds, while any session is live |
| `agentSessions.usage.enabled` | `true` | |
| `agentSessions.usage.claudeNetwork` | `true` | allow the Anthropic usage request |
| `agentSessions.usage.codexNetwork` | `true` | allow the chatgpt.com usage request |
| `agentSessions.usage.refreshInterval` | `120` | seconds |
| `agentSessions.claudeHome` | `""` | overrides `$CLAUDE_CONFIG_DIR` / `~/.claude` |
| `agentSessions.codexHome` | `""` | overrides `$CODEX_HOME` / `~/.codex` |
| `agentSessions.phoneMode` | `false` | one workbench part at a time, for the window served by `pnpm phone` |

## On a phone

`pnpm phone` serves the real VS Code workbench through `code serve-web`, cut down to two screens: the Sessions view
filling the window, and a Codex or Claude Code panel filling the window with a **Back to Sessions** arrow in its title
bar. Sessions are the vendors' own panels, so sending messages, reading history, renaming and everything else in the
list's buttons and menus work as on the desktop.

```sh
pnpm package                       # the vsix the phone window installs
pnpm phone --port 8321             # prints the URL and the password
pnpm phone --install-service --host 172.17.0.1 --port 8321   # systemd user unit, survives logout and reboot
```

- The window lives in its own server data dir, `~/.agent-sessions/web`: its own Machine settings (activity bar, status
  bar and command center hidden, `agentSessions.phoneMode` on), its own extensions (this one, Codex, Claude Code,
  installed from the marketplace on first run). The desktop's settings and windows are untouched. The `code` CLI is
  taken from `~/.vscode-server`, `PATH`, or `AGENT_SESSIONS_CODE`.
- The URL opens a folder (`--folder`, home by default). Opening a Claude session from another folder moves the window
  there first (a reload, a few seconds), since Claude Code resumes only that folder's sessions. **New Claude / New
  Codex** first asks for the folder, offering the recent sessions' folders, since a session is filed under the folder
  it starts in. The server runs with workspace trust disabled, so no Restricted Mode prompt appears for any folder
  (the `code` CLI only downloads the web build; its own `code-server` is what runs, since the CLI has no such flag).
  Reloading keeps the list screen.
- The port asks for a password (HTTP basic auth, any user name), generated once into `~/.agent-sessions/web/password`
  or read from `--password-file`; `--no-password` opens the port. serve-web itself stays on loopback behind the gate.
  Pinch-zoom and the browser's zoom level scale the workbench.
- It is plain HTTP. Use it on a trusted network, over `ssh -L 8321:127.0.0.1:8321 host`, or put a TLS proxy in front
  (the password prompt passes through). With a containerised Caddy, bind to the Docker host gateway
  (`--host 172.17.0.1`) and route `agents.example.com { reverse_proxy host.docker.internal:8321 }`: nothing but the
  proxy reaches the port. `--install-service` writes a systemd user unit with the same flags and enables lingering.
- Phone mode moves the extension's views into a secondary side bar container and maximizes it, which is the workbench's
  own full-window layout for chat; opening or revealing a session closes the side bars; Back, or closing the last tab, restores the list. Back leaves the
  tabs open behind the list, since closing a Claude Code or Codex panel ends that session's process.

The launcher fixes the workbench for a phone: dark theme, VS Code's built-in chat and agent features off, no extension recommendations, telemetry or experiments, no port-forwarding offers, Git repository scan, file watching or task detection, extension auto-updates off, of the built-in extensions only Git and the default themes (the rest are moved out of the downloaded web build at each launch: no grammars, language servers, file viewers, Copilot or sign-in), and notifications at the top below the editor tabs (a stylesheet the launcher's proxy adds to the page, so it also fronts serve-web without a password). Codex is pinned to 26.908 because later builds depend on a Codex Audio extension the web client cannot run.



## Caveats

- The view container id is `agentSessionsHub`, not `agentSessions`: VS Code reserves the `agentSessions` views key for its built-in Agent Sessions view and silently drops extension views contributed under it.

- Opening sessions relies on two undocumented surfaces: the Claude Code extension's `claude-vscode.editor.open` command arguments and the Codex extension's `openai-codex:` custom editor URI. Either vendor can change them; the terminal fallback still works when they do.
- Sessions archived inside the Claude Code extension itself are not detected, because that list lives in the extension's private storage.
- "Replied" cannot know whether you have read the reply; it means the agent's turn ended and the process is still up.
- Live sessions are ordered by start time (newest first), which holds still while agents work; history is ordered by the last message's timestamp (Claude transcripts, Codex's `updated_at_ms`), not file mtime, which both tools rewrite on resume and maintenance.
- The Claude spark and Codex blossom are their owners' marks, copied from the installed extensions for recognisability; they are not part of this project's MIT licence.

MIT.

**Copy Transcript** (row button and context menu) puts the conversation on the clipboard as Markdown: the person's prompts and the agent's replies only — tool calls, tool results, reasoning, system and developer instructions, IDE context blocks and interruption markers are left out. Consecutive assistant records merge into one reply.
