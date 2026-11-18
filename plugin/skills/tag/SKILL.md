---
name: tag
description: Tag this session with what it is about, so the user's session list can group and filter by it. Use as soon as the work turns out to be for one customer company (tenant:<company>) or one product area (area:<area>), when it reaches another, and when the user runs /tag.
argument-hint: <key:value>
---
Tags say what a session is about, outside the chat: the user's list groups sessions by tenant and shows the rest beside the title.

1. Tag as soon as you know, without being asked: `~/.agent-sessions/bin/agent-sessions tag add "<key>:<value>"`.
   - `tenant:<company>` when the work is for one customer company, named as its tenant is (the company name the dashboard shows), not its domain or a ticket's wording.
   - `area:<product area>` for the part of the product the work changes (widget, phone, tarjous, dashboard, crawl).
   - Anything else only when the user names it with /tag.
2. Work for several companies gets a tenant tag for each; internal work gets none.
3. A tag that turned out wrong is removed: `~/.agent-sessions/bin/agent-sessions tag remove "<key>:<value>"`.
4. `~/.agent-sessions/bin/agent-sessions list` shows the session's tags on its first line.
