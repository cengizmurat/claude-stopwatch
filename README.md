# ⏱ claude-stopwatch

**See where Claude Code spends its time.**

A side panel for Claude Code that shows how long every tool call and every
subagent takes: totals per tool, call counts, and the slowest calls, kept
per session.

The plugin is named `tool-timings`.

```
 Tool timings
 ─────────────────────────────────────────────────────────
 42 calls · 3m 18s tool time · 2 subagents

 Running now
 Bash  npm run test:e2e                              12.4s

 By tool                              sorted by total time
 Tool                    Calls    Total     Avg      Max
 Bash                       14   2m 31s   10.8s    48.2s
 Agent                       2    31.0s   15.5s    22.1s
 WebFetch                    3     9.7s    3.2s     5.0s
 Read                       17     1.2s    71ms    240ms
 Grep (1 failed)             6     0.6s   100ms    310ms

 Subagents
 Explore  Find the auth config                       22.1s
 Plan  Plan the database migration           failed 8.9s

 Slowest calls
 1. Bash  npm run build                              48.2s
 2. Bash  pytest tests/integration                   31.5s
 3. Agent  Find the auth config                      22.1s
```

## Why

Some sessions feel slow, but it is hard to tell why. Is it a slow test
command, a large search, a web fetch, or a subagent that ran for minutes?
This panel tells you right away, while the session runs.

## Features

- **Totals per tool**: number of calls, total time, average and longest
  call. Failed calls are counted next to the tool name.
- **Three sort orders**: press the "sorted by …" button to sort by total
  time, number of calls, or slowest call.
- **Subagents**: each subagent run with its type, its task, how long it
  ran, and whether it finished, failed or was stopped.
- **Slowest calls**: the 10 slowest single calls, with the command, file or
  pattern they used. A call made inside a subagent shows the subagent type
  in brackets.
- **Running now**: calls that have started and not finished yet.
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
