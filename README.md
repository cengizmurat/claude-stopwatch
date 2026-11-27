# ⏱ claude-stopwatch

**See where Claude Code spends its time.**

A side panel for Claude Code that shows how long every tool call and every
subagent takes: totals per tool, call counts, and the slowest tools, kept
per session.

The plugin is named `tool-timings`.

```
 Tool timings
 ──────────────────────────────────────────────────────────────────
 ⏱ 42 calls · 3m 18s tool time · 2 subagents · 🙋 1m 5s waiting for you

 By tool
 Tool                    Calls    Total  Share     Avg      Max
 Bash                       14   2m 31s    76%   10.8s    48.2s
 Agent                       2    31.0s    16%   15.5s    22.1s
 list_issues Linear          3     9.7s     5%    3.2s     5.0s
 Read                       17     1.2s     1%    71ms    240ms
 Grep 1 failed               6     0.6s     0%   100ms    310ms

 Subagents
 Explore                                             done     22.1s
   Find the auth config
 Plan                                              failed      8.9s
   Plan the database migration

 Slowest tools
 1.  Bash                                                     48.2s
     npm run build
 2.  Bash                                                     31.5s
     pytest tests/integration
 3.  Agent                                                    22.1s
     Find the auth config
```

## Why

Some sessions feel slow, but it is hard to tell why. Is it a slow test
command, a large search, a web fetch, or a subagent that ran for minutes?
This panel tells you right away, while the session runs.

## Above the prompt and in the status line

You do not need the panel open to see what is slow.

**The band above the prompt**, while Claude works, lists what runs right
now, with times that tick every second, and counts this turn:

```
⏳ Working · this turn 6 calls, 14.2s in tools, 1 subagent          48.0s
  💻 Bash  npm run test:e2e                                         12.4s
  🤖 Explore  Find the auth config                                  31.0s
```

When the turn ends, it becomes one line that sums the turn up, with
**Details** (opens the panel) and **Hide** buttons:

```
✅ Last turn 1m 12s · 14 calls · 38.0s in tools · 🐢 Bash 31.0s  npm run build   Details  Hide
```

**The status line** always shows the session totals and the slowest call.
While something runs, it shows that first, with its live time:

```
⏱ 42 calls · 3m 18s in tools · 🐢 Bash 48.2s
💻 Bash 12.4s, 🤖 Explore 31.0s │ 42 calls · 3m 18s in tools
```

## Features

- **Totals per tool**: number of calls, total time, average and longest
  call. Failed calls are counted next to the tool name.
- **Sorted by total time**: the tool that took the most time in all comes
  first.
- **Subagents**: each subagent run with its type, its task, how long it
  ran, and whether it finished, failed or was stopped.
- **Waiting for you**: a section of its own for the time Claude waits on
  you: ❓ questions (`AskUserQuestion`), 🔐 permission prompts (from the
  prompt to the moment the tool starts) and 📜 plan approvals. It shows
  totals per kind, and how many permission prompts got a "no". This time is not counted as tool time.
- **Slowest tools**: the 10 slowest single tool calls, with the command, file or
  pattern they used. A call made inside a subagent shows the subagent type
  in brackets.
- **Colors and emojis**: each tool has an emoji (💻 Bash, 📖 Read,
  📝 Edit, 🔍 Grep, 🌐 web, 🤖 Agent, 🔌 MCP tools). Times are green when
  fast (under 2s), yellow in between, and red when slow (15s or more).
  Subagents show ✅ done, ❌ failed, 🛑 stopped or ⏳ running. Colors use your
  theme's own colors, so they work in light and dark themes.
- **Fair numbers**: tool times come from Claude Code's own `duration_ms`,
  so time spent waiting at a permission prompt is not counted.
- **One log per session**: a resumed session shows its earlier numbers
  again. `/clear` starts a new, empty log.
- **Safe**: the plugin only watches events. It never blocks, changes or
  repeats a tool call or a subagent, even if it has an error. It does not
  turn off moving a Bash command to the background.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install tool-timings --marketplace cengizmurat/claude-stopwatch
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

From a shell:

```bash
claude plugin install tool-timings --marketplace cengizmurat/claude-stopwatch
```

In the desktop app: click **+** next to the prompt box, then **Plugins**,
**Add marketplace** with `cengizmurat/claude-stopwatch`, then **Add plugin**.

## Use

The panel opens by itself when a session starts. If you closed it, or your
window is too narrow for it to open on its own:

| Command | What it does |
| --- | --- |
| `/tool-timings` | Opens the panel. |
| `/tool-timings summary` | Prints the same numbers as text in the chat. |
| `/tool-timings reset` | Clears the log of the current session. |
| `/tool-timings band off` | Stops using the band above the prompt, in every session. |
| `/tool-timings band on` | Uses the band again. |
| `/tool-timings emoji off` | Draws plain text with no emojis, in every session. |
| `/tool-timings emoji on` | Draws emojis again. |

The panel also has a button at the bottom to clear the current session's
log.

## Where the data is kept

Everything stays on your machine. Each session's log is saved in the
plugin's own store, under Claude Code's configuration folder, keyed by the
session id. The last 30 sessions are kept, and older ones are deleted. The
plugin sends nothing over the network.

## Development

The plugin is one hooks module, `hooks/register.tsx`. Its saved state is
described in `types/index.d.ts`.

To try a local copy in one session:

```bash
claude --plugin-dir .
```

To check it and run its tests:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

## License

MIT. See [LICENSE](LICENSE).
