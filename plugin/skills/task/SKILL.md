---
name: task
description: Record a task the user gives this session so it stays listed under the session until it is done. Use when the user gives one with /task, and whenever a new deliverable is agreed.
argument-hint: <task>
---
The task is what the user wrote with this command.

1. Record it first, under a short name of the deliverable ("Create v2 phone engine"), never a step of one: `~/.agent-sessions/bin/agent-sessions task add "<name>"`. It prints the task's id.
2. Do it.
3. When it is finished and checked, close it with what was delivered and where, in a line or two: `~/.agent-sessions/bin/agent-sessions task done <id> "<what was delivered>"`. If it is abandoned, `task drop <id> "<why>"`.
