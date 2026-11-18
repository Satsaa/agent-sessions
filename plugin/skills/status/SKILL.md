---
name: status
description: Say where this session stands, shown as its icon in the user's session list — partial (part delivered, the rest left), needs attention (something needs the user's look), or none. Use whenever the session reaches a stopping point short of done, when something needs the user to look at it, when such a status stops being true, and when the user runs /status.
argument-hint: partial|attention|clear [text]
---
The status is the session's icon in the user's list, so they see at a glance which sessions need them without opening each one. A session that is running shows its spinner whatever its status says.

| Status | Icon | When |
|---|---|---|
| done | green check | All the work is delivered: use the **done** skill, never this one. |
| partial | yellow check | Part of the work is delivered and the rest is not: stopped at a limit, waiting on something outside the session, or the user chose to stop here. |
| attention | bell | Something needs the user's look before the session can go on or be trusted: a failure, a decision only they can make, a result to check, a deploy that went red. |
| none | the session's usual icon | Nothing needs saying. This is the default. |

1. Set it when it becomes true, in the same turn, with one line the user reads in the list:
   - `~/.agent-sessions/bin/agent-sessions status partial "<what is delivered; what is left and why>"`
   - `~/.agent-sessions/bin/agent-sessions status attention "<what needs the user's look>"`
2. **Clear it as soon as it no longer holds**: `~/.agent-sessions/bin/agent-sessions status clear`. A status left behind is wrong: the user resumed the work, answered what needed them, or the rest got done.
3. A question waiting for the user is already shown by `ask-user`; set `attention` only for what is not a question.
4. Marking the session done (the done skill) replaces the status; setting a status takes done away.
