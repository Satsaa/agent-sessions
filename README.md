# Agent Sessions

A VS Code sidebar that lists your **Claude Code** and **Codex** sessions together, shows which ones are working, waiting for you or stopped, and opens any of them as a normal editor tab. Built for people who run several agents at once, often in git worktrees, and want one place to see them.

## What it shows

**Sessions view** — every session from `~/.claude` and `~/.codex`, newest first, grouped by activity (Live / History) by default.

| Icon | State | Meaning |
| --- | --- | --- |
| spinning sync (green) | Working | the agent is doing things right now |
| bell (orange) | Needs your input | it stopped on a permission prompt or a question |
| speech bubbles (blue) | Replied | it finished its turn and its process is alive, waiting for your next message |
| hollow circle (grey) | Stopped | no process holds the session; it is history |

Each row's description shows the tool, the **worktree** (or branch when it is the main checkout) and how long ago it was touched. A worktree row also carries `↑N` commits ahead of its upstream (or of the main checkout when the branch has no upstream) and `✎N` changed files, refreshed with the list. The tooltip has the worktree path, branch, the directory the session was started in, PID and session id.

Worktrees are detected from what the agent actually did, not from where it was launched — sessions usually start in the repository and move into a worktree later:

- Claude Code writes a `worktree-state` record into the transcript when a session enters or leaves a worktree (`EnterWorktree` / `ExitWorktree`, `claude -w`); the latest one wins. Without one, the shell's most recent recorded cwd decides.
- Codex records a thread's cwd once and never moves it, so the rollout's tool calls are scanned for the last `workdir`, `cd` or `git -C` directory; a directory inside a linked worktree names it.

**Worktrees view** (collapsed by default) — every git worktree of the repositories in play: the workspace's repos plus any repo a live or recent session ran in, the main checkout included. Each row shows the branch, `↑ahead ↓behind` its base and `✎` changed files; expanding it shows the breakdown (staged, unstaged, untracked) and the agents bound to that worktree — live ones first, then the last few stopped sessions — as ordinary session rows that open on click. A worktree with a live agent takes that agent's state icon. The base is the branch's upstream when it has one, else the remote's default branch, else the main checkout's HEAD (detached promotion checkouts land there, so their counts are large by nature). Right-click a worktree to open it in a new window, open a terminal there, copy its path, or start a Claude / Codex session in it.

**Usage view** — subscription limits for both accounts:

- **Claude**: session (5h) and weekly windows, plus any model-specific or extra-usage limits your plan reports, with reset times. Fetched from Anthropic's OAuth usage endpoint with the credential Claude Code already stores locally (the same call the CLI makes for `/usage`). Can be turned off with `agentSessions.usage.claudeNetwork`.
- **Codex**: the rate-limit snapshot Codex writes into every rollout's `token_count` event, so it is as fresh as your last Codex turn and involves no network call.

Two status bar items mirror this: working / waiting / replied counts on the left, usage percentages on the right. The Sessions view carries a badge with the number of sessions waiting for input.

## Actions

- **View: Show Agent Sessions** opens the sidebar from the command palette (VS Code files it under *View*, not *Agent Sessions*; the built-in view of the same name is a different entry); **Agent Sessions: Show Sessions** and **Agent Sessions: Show Worktrees** focus one view.
- **Click a session** to open it. Claude sessions open in a Claude Code tab in the *active* editor group (not a new locked group). Codex threads open in the Codex conversation editor. If a session is already open, its tab is revealed.
- **New Claude / New Codex** buttons in the view title start a fresh session, again as a tab.
- Right-click: Resume in Terminal (`claude --resume` / `codex resume` in the session's cwd), Copy Resume Command, Open Transcript File, Open Working Directory in New Window, Archive / Unarchive.
- View menu: show/hide archived sessions, show/hide subagent threads, only this repository (worktrees of the workspace's repo included), group by Activity / Repository / Tool / None.

If the Claude Code or Codex extension is not installed, opening falls back to a terminal.

## Filtering defaults

- **Archived** sessions are hidden. Codex's own archive flag is honoured; sessions archived from this view are remembered by the extension.
- **Subagent threads** (Codex threads spawned by another thread) are hidden.
- **Empty** stopped sessions where no prompt was ever sent are hidden.
- History is capped at 200 sessions (`agentSessions.historyLimit`).

## How it reads state

Nothing is written to either tool's directories. Everything is read-only:

- Claude live status comes from `~/.claude/sessions/<pid>.json` (busy / waiting / idle) after checking the PID is alive; titles from the transcript's `custom-title` / `ai-title` records or the first prompt; cwd and branch from the transcript.
- Codex threads come from `state_*.sqlite` via `node:sqlite` (read-only), turn status from `thread_history_*.sqlite`, liveness from `thread-writer-locks/`. On a host without `node:sqlite` it falls back to scanning the rollout files.
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
| `agentSessions.usage.refreshInterval` | `120` | seconds |
| `agentSessions.claudeHome` | `""` | overrides `$CLAUDE_CONFIG_DIR` / `~/.claude` |
| `agentSessions.codexHome` | `""` | overrides `$CODEX_HOME` / `~/.codex` |

## Caveats

- The view container id is `agentSessionsHub`, not `agentSessions`: VS Code reserves the `agentSessions` views key for its built-in Agent Sessions view and silently drops extension views contributed under it.

- Opening sessions relies on two undocumented surfaces: the Claude Code extension's `claude-vscode.editor.open` command arguments and the Codex extension's `openai-codex:` custom editor URI. Either vendor can change them; the terminal fallback still works when they do.
- Sessions archived inside the Claude Code extension itself are not detected, because that list lives in the extension's private storage.
- "Replied" cannot know whether you have read the reply; it means the agent's turn ended and the process is still up.

MIT.
