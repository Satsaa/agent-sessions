---
name: answer
description: Record a question the user asks so it stays listed under this session, with your answer, until it is answered. Use when the user asks with /answer, and whenever they ask a question your same short reply will not answer fully; when in doubt, record it.
argument-hint: <question>
---
The question is what the user wrote with this command.

1. Record it first, in the same turn, before any work, in their words: `~/.agent-sessions/bin/agent-sessions answer add -`, the question on standard input. It prints its id.
2. Answer it. Write the answer in your reply, and record the same answer with `~/.agent-sessions/bin/agent-sessions answer write <id> -`, the text on standard input. The user reads recorded answers outside this conversation, so the text must make sense on its own.
   **A recorded answer is terse and specific**: only what answers the question, with no hedging, no restating of the question, and no filler or obvious context. Give each point a short header with bullets under it, never paragraphs of prose.
3. If the answer needs work you cannot finish in this turn, say so and leave it open; answer it in both places when you have it.
4. **A recorded answer always matches the latest answer in the conversation.** When a later reply changes, corrects or extends it (a follow-up such as "are you sure?" shifts the answer), record it again with `answer write <id> -` in the same turn, before ending it. A stale recorded answer is wrong.
