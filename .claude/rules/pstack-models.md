# pstack model configuration

Per-role model overrides for pstack skills. Each pstack SKILL.md names its defaults in a Models section; the values here override those defaults. Delete a line to fall back to the skill default. A value of `inherit-parent` or `auto` runs that role on the parent session's model (the `Agent` call omits `model`); an alias entry in a panel list still counts toward that panel's fan-out. A model may carry a reasoning effort, as in `sonnet @xhigh` (levels: low, medium, high, xhigh, max); the role's subagent then runs at that level, each entry of a panel list on its own. `default effort` sets the level for a value without one; `session` uses the runtime's platform mapping to start from the parent session's effort. On Codex this requires active-turn metadata or an explicit effort choice. `session hook: off` stops the Claude Code, Codex, or Muse SessionStart hook, or the pstack Pi extension, from injecting the poteto-mode mandate; any other value, or no line, leaves it on.

feature, refactoring: sonnet
bug-fix: sonnet
perf-issue: sonnet
hillclimb: sonnet
judgment and prose: sonnet
strongest judgment: sonnet
how explorer: sonnet
how explainer: sonnet
why investigators: sonnet
why synthesizer: sonnet
reflect tooling: sonnet
reflect judgment, divergent, synthesizer: sonnet
arena runners: sonnet, haiku
arena cross-judge pool: sonnet, haiku
swarm workers: sonnet
architect runners: sonnet, haiku
interrogate reviewers: sonnet, haiku
thermos reviewers: sonnet
no-comments reviewer: sonnet

default effort: session
session hook: on
