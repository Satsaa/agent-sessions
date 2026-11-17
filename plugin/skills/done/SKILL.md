---
name: done
description: Close this session and mark it done in the Agent Sessions view. Use when the user says the session is done or asks to finish, wrap up or close it, and when all the work a session was given is delivered and nothing is left open.
---
A done session is one the user can stop reading: everything it was given is delivered or accounted for. Check each part below against what is true now, not against what you remember doing, and fix what you find before marking anything.

1. **Tasks, answers and questions.** Run `~/.agent-sessions/bin/agent-sessions list`. Close every open task with what was delivered and where (`task done <id> "<…>"`) or why it was abandoned (`task drop <id> "<why>"`). Answer every open question of the user's in your reply and with `answer write <id> -`, or mark it `answer stale <id>` if it no longer matters. A question you asked the user that still waits for them is asked again in your reply, and the session is not done until they answer it (`question answered <id> -`) or it no longer needs them (`question stale <id>`). Recorded answers and task summaries are terse and specific: only what answers the question or says what was delivered, with no hedging, no restating, and no filler or obvious context; a short header per point with bullets under it, never paragraphs of prose. Re-record any answer the conversation has since changed, corrected or extended: a stale recorded answer is wrong. Work the session did that was never recorded as a task is added and closed now.
2. **Features.** For each thing delivered, confirm where it is: committed, merged and pushed where the project lands its work, or exactly what is not and why. Unmerged or unpushed work is not delivered.
3. **Tickets.** For each issue or ticket this session worked on, confirm its status says what is true now and update it where the project's rules let you. List each one with its status.
4. **Cleanup.** Remove what this session created and no longer needs, following the project's rules: its worktrees whose work is merged, temporary files, background processes and servers it started. Never remove another session's worktree, anything with uncommitted or unmerged work, or anything the user asked to keep; list those as left, with the reason.
5. **Mark it.** Record all three, each written to be read without the conversation:

   ```
   ~/.agent-sessions/bin/agent-sessions done \
     --features "<what was delivered and where>" \
     --tickets "<each ticket and its status now, or: none>" \
     --cleanup "<what was removed, and what was left and why, or: nothing to clean up>"
   ```

   The command refuses while a task, an answer or a question is open. Never work around a refusal by dropping a task or marking an answer or a question stale that is not: finish it, or tell the user what blocks the session from being done and leave it open.
6. Tell the user in a few lines what the session delivered and anything left for them.

A later task, answer or question reopens the session by itself; `~/.agent-sessions/bin/agent-sessions reopen` does it by hand.
