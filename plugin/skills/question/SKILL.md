---
name: question
description: Record a question you ask the user so it stays listed under this session, waiting for them, until they answer it. Use whenever you ask the user something (a decision only they can make, something you need from them, a choice you offer), and when the user runs /question to see what is waiting for them.
argument-hint: "[question]"
---
A question here is one **you** ask the user. The user sees it listed under the session, marked as waiting for them, until it is answered.

- **Asking.** Record each question the moment you ask it, in the same turn: `~/.agent-sessions/bin/agent-sessions question add -`, the question on standard input, worded to make sense on its own outside the conversation. One question per record; it prints its id.
- **Answered.** When the user answers it, in the chat or by acting on it, record what they answered in the same turn: `~/.agent-sessions/bin/agent-sessions question answered <id> -`, their answer on standard input, terse. A question the user marked answered in the view is already settled.
- **No longer needed.** `~/.agent-sessions/bin/agent-sessions question stale <id>` when the work moved on and it no longer needs them.
- **Run by the user.** Without a question: run `~/.agent-sessions/bin/agent-sessions list` and ask again, one per line, each question still waiting for them. With a question: it is one they want you to put to them later; record it as above.

A session is never marked done while a question waits for the user.
