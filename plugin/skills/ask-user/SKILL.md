---
name: ask-user
description: A question you ask the user, recorded so it stays listed under this session, waiting for them, until they answer it. Use whenever you ask the user something (a decision only they can make, something you need from them, a choice you offer). When the user runs /ask-user, list what waits for them. A question the user asks you is /ask, never this.
---
A question here is one **you** ask the user. The user sees it listed under the session, marked as waiting for them, until it is answered.

- **Asking.** Record each question the moment you ask it, in the same turn: `~/.agent-sessions/bin/agent-sessions ask-user add -`, the question on standard input, worded to make sense on its own outside the conversation. One question per record; it prints its id.
- **Answered.** When the user answers it, in the chat or by acting on it, record what they answered in the same turn: `~/.agent-sessions/bin/agent-sessions ask-user answered <id> -`, their answer on standard input, terse. A question the user marked answered in the view is already settled.
- **No longer needed.** `~/.agent-sessions/bin/agent-sessions ask-user stale <id>` when the work moved on and it no longer needs them.
- **Run by the user.** Run `~/.agent-sessions/bin/agent-sessions list` and ask again, one per line, each question still waiting for them. If they wrote a question with the command, it is their own question to you: handle it as /ask does.

A session is never marked done while a question waits for the user.
