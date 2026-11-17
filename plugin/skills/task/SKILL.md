---
name: task
description: Record a task the user gives this session so it stays listed under the session until it is done. Use when the user gives one with /task, and the moment they ask for any deliverable (a plan, a doc, a skill change, a code change, a fix), small ones and ones delegated to a subagent included; when in doubt, record it.
argument-hint: <task>
---
The task is what the user wrote with this command.

1. Record it first, in the same turn, before any work, under a short name of the deliverable ("Create v2 phone engine"), never a step of one: `~/.agent-sessions/bin/agent-sessions task add "<name>"`. It prints the task's id.
2. Do it.
3. When it is finished and checked, close it with what was delivered and where, in a line or two: `~/.agent-sessions/bin/agent-sessions task done <id> "<what was delivered>"`. If it is abandoned, `task drop <id> "<why>"`.
   **Either summary is terse and specific**: only what was delivered or why not, with no hedging, filler or obvious context. Give each point a short header with bullets under it, never paragraphs of prose.
