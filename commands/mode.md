---
description: Change SkillMe settings: on | off | pause | resume | calm | intense | autoopen-on | autoopen-off
argument-hint: "on | off | pause | resume | calm | intense | autoopen-on | autoopen-off"
---

Change SkillMe settings according to: $ARGUMENTS

Map it to one `skillme_settings` call:
- `on` → `mode: "arena"`; `off` → `mode: "off"` (every project)
- `pause` → `paused: true` (this project only); `resume` → `paused: false`
- `calm` → `quiz_every_edits: 6, quiz_every_lines: 120, stop_hook_quiz: false`
- `intense` → `quiz_every_edits: 2, quiz_every_lines: 25, stop_hook_quiz: true`
- `autoopen-on` / `autoopen-off` → `auto_open_arena: true / false`
- anything else / empty → call `skillme_settings` with no arguments, then show the current settings along with these options.

Confirm the result in one line.
