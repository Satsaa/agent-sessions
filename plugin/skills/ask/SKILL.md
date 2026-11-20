---
name: ask
description: A question the user asks you, recorded so it stays listed under this session with your answer until it is answered. Use when the user runs /ask, and whenever they ask a question your same short reply will not answer fully; when in doubt, record it. A question you ask the user is /ask-user, never this.
argument-hint: <question>
---
The question is the user's own: what they wrote with this command. You answer it.

1. Record it first, in the same turn, before any work, in their words, with a title of what it is about in at most three words (`--title "Agent Sessions"`), listed before the text, which never repeats it: `~/.agent-sessions/bin/agent-sessions ask add --title "<title>" -`, the question on standard input. It prints its id.
2. Answer it with `~/.agent-sessions/bin/agent-sessions ask write <id> -`, the text on standard input. The user reads recorded answers inline and on their own, so the text must make sense without the conversation, and your reply never repeats it: at most a small note about it.
   **A recorded answer is terse and specific**: only what answers the question, with no hedging, no restating of the question, and no filler or obvious context. Give each point a short header with bullets under it, never paragraphs of prose.
3. If the answer needs work you cannot finish in this turn, say so and leave it open; record the answer when you have it.
4. **A recorded answer always matches the latest answer in the conversation.** When a later reply changes, corrects or extends it (a follow-up such as "are you sure?" shifts the answer), record it again with `ask write <id> -` in the same turn, before ending it. A stale recorded answer is wrong.
5. `~/.agent-sessions/bin/agent-sessions ask stale <id>` marks a question of theirs that no longer matters.
