---
name: question
description: Record a question the user asks so it stays listed under this session until it is answered. Use when the user asks with /question, and whenever they ask something beside other work that will not be answered in the same reply.
argument-hint: <question>
---
The question is what the user wrote with this command.

1. Record it first, in their words: `~/.agent-sessions/bin/agent-sessions question add -`, the question on standard input. It prints the question's id.
2. Answer it. Write the answer in your reply, and record the same answer with `~/.agent-sessions/bin/agent-sessions question answer <id> -`, the text on standard input. The user reads recorded answers outside this conversation, so the text must make sense on its own.
3. If the answer needs work you cannot finish in this turn, say so and leave the question open; answer it in both places when you have it.
