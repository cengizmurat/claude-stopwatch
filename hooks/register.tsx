import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AgentRecord,
  CallRecord,
  SortKey,
  TimingLog,
  ToolStat,
} from '../types'

const PANE = 'tool-timings'
const TITLE = 'Tool timings'
const KEEP_SLOWEST = 10
const KEEP_AGENTS = 50
const KEEP_SESSIONS = 30
const FLUSH_MS = 2000

// Change the shape tag when TimingLog changes: it makes a new version of
// the code ignore what an older version stored.
const SHAPE = 'timing-log-1'

const log = atom({ plugin: 'tool-timings', key: 'log' } as const, blank(''), {
  shape: SHAPE,
})
const sort = atom({ plugin: 'tool-timings', key: 'sort' } as const, 'total')

type Dollar = EngineInterface

function blank(sessionId: string, startedAt = 0): TimingLog {
  return {
    sessionId,
    startedAt,
    totalCalls: 0,
    totalMs: 0,
    tools: {},
    slowest: [],
    running: {},
    agents: [],
  }
}

// ---------- session handling and saving ----------

// The session whose saved log is already in `$.state`. Module variables
// start over at a reload, so this is checked again after one.
let loadedSession = ''
let flushPending = false
// This session's id, read once; `session.end` (a /clear too) forgets it.
let sessionIdCache = ''

async function sessionIdOf($: Dollar): Promise<string> {
  if (sessionIdCache === '') sessionIdCache = await $.session.id()
  return sessionIdCache
}

function storeKey(sessionId: string): string {
  return `session:${sessionId}`
}

function isLog(value: unknown): value is { shape: string; value: TimingLog } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { shape?: unknown; value?: unknown }
  return v.shape === SHAPE && typeof v.value === 'object' && v.value !== null
}

/** Makes sure `$.state` holds the log of `sessionId`, loading a saved one. */
async function useSession($: Dollar, sessionId: string): Promise<void> {
  if (sessionId === '' || loadedSession === sessionId) return
  const current = await read($, log)
  if (current.sessionId !== sessionId) {
    const saved = await $.store.get(storeKey(sessionId))
    const now = await $.clock.now()
    const next = isLog(saved)
      ? { ...saved.value, running: {} }
      : blank(sessionId, now)
    await update($, log, () => next)
  }
  loadedSession = sessionId
}

async function flush($: Dollar): Promise<void> {
  try {
    await save($)
  } catch {
    // Saving is best effort: the live panel still has the numbers.
  }
}

async function save($: Dollar): Promise<void> {
  const value = await read($, log)
  if (value.sessionId === '') return
  await $.store.set(storeKey(value.sessionId), { shape: SHAPE, value })
  const list = await $.store.get('sessions')
  const ids = Array.isArray(list)
    ? list.filter((id): id is string => typeof id === 'string')
    : []
  const nextIds = [...ids.filter(id => id !== value.sessionId), value.sessionId]
  const dropped = nextIds.slice(0, Math.max(0, nextIds.length - KEEP_SESSIONS))
  for (const id of dropped) await $.store.delete(storeKey(id))
  await $.store.set('sessions', nextIds.slice(-KEEP_SESSIONS))
}

function scheduleFlush($: Dollar): void {
  if (flushPending) return
  flushPending = true
  $.clock.after(FLUSH_MS, () => {
    flushPending = false
    void flush($)
  })
}

/** Changes this session's log and saves it a little later. */
async function change(
  $: Dollar,
  sessionId: string,
  fn: (value: TimingLog) => TimingLog,
): Promise<void> {
  try {
    await useSession($, sessionId)
    await update($, log, value =>
      fn(value.sessionId === sessionId ? value : blank(sessionId, Date.now())),
    )
    scheduleFlush($)
  } catch {
    // A timing that fails to record must never stop the work it times.
  }
}

// ---------- reading tool input ----------

const LABEL_FIELDS = [
  'command',
  'file_path',
  'notebook_path',
  'pattern',
  'url',
  'query',
  'skill',
  'description',
  'path',
  'prompt',
] as const

function labelOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  for (const name of LABEL_FIELDS) {
    const value = fields[name]
    if (typeof value === 'string' && value.trim() !== '') {
      const line = value.replace(/\s+/g, ' ').trim()
      return line.length > 80 ? `${line.slice(0, 79)}…` : line
    }
  }
  return ''
}

// ---------- recording ----------

function finishCall(
  value: TimingLog,
  id: string,
  tool: string,
  label: string,
  ms: number,
  at: number,
  isError: boolean,
  agentType: string | undefined,
): TimingLog {
  const { [id]: _done, ...running } = value.running
  const old: ToolStat = value.tools[tool] ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    errors: 0,
  }
  const stat: ToolStat = {
    count: old.count + 1,
    totalMs: old.totalMs + ms,
    maxMs: Math.max(old.maxMs, ms),
    errors: old.errors + (isError ? 1 : 0),
  }
  const call: CallRecord = { id, tool, label, ms, at, isError }
  if (agentType !== undefined) call.agentType = agentType
  const slowest = [...value.slowest.filter(one => one.id !== id), call]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, KEEP_SLOWEST)

  return {
    ...value,
    totalCalls: value.totalCalls + 1,
    totalMs: value.totalMs + ms,
    tools: { ...value.tools, [tool]: stat },
    slowest,
    running,
  }
}

function endAgent(
  value: TimingLog,
  agentId: string,
  now: number,
  status: AgentRecord['status'],
  onlyIfRunning: boolean,
): TimingLog {
  let found = false
  const agents = value.agents.map(one => {
    if (one.id !== agentId) return one
    if (onlyIfRunning && one.status !== 'running') return one
    found = true
    return { ...one, status, ms: one.ms ?? now - one.startedAt }
  })
  return found ? { ...value, agents } : value
}

// ---------- drawing helpers ----------

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

const SORT_LABEL: Record<SortKey, string> = {
  total: 'total time',
  count: 'calls',
  max: 'slowest call',
}
const NEXT_SORT: Record<SortKey, SortKey> = {
  total: 'count',
  count: 'max',
  max: 'total',
}

function sortedTools(
  value: TimingLog,
  by: SortKey,
): Array<[string, ToolStat]> {
  const rows = Object.entries(value.tools)
  const key = (s: ToolStat) =>
    by === 'count' ? s.count : by === 'max' ? s.maxMs : s.totalMs
  return rows.sort((a, b) => key(b[1]) - key(a[1]))
}

function textSummary(value: TimingLog, by: SortKey): string {
  if (value.totalCalls === 0 && value.agents.length === 0) {
    return 'No tool calls timed yet in this session.'
  }
  const lines = [
    `Tool time in this session: ${value.totalCalls} calls, ${formatMs(value.totalMs)} in all.`,
    '',
    'By tool:',
  ]
  for (const [tool, s] of sortedTools(value, by)) {
    lines.push(
      `  ${tool}: ${s.count} calls, ${formatMs(s.totalMs)} total, avg ${formatMs(s.totalMs / s.count)}, max ${formatMs(s.maxMs)}`,
    )
  }
  if (value.agents.length > 0) {
    lines.push('', 'Subagents:')
    for (const a of value.agents) {
      const time = a.ms === undefined ? 'running' : formatMs(a.ms)
      lines.push(`  ${a.type} – ${a.description}: ${time} (${a.status})`)
    }
  }
  if (value.slowest.length > 0) {
    lines.push('', 'Slowest calls:')
    for (const c of value.slowest) {
      lines.push(`  ${formatMs(c.ms)}  ${c.tool}  ${c.label}`)
    }
  }
  return lines.join('\n')
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    loadedSession = ''
    sessionIdCache = ''
    const sessionId = await sessionIdOf($)
    await useSession($, sessionId)
    // Nothing runs while a session starts: drop calls a reload left open.
    await update($, log, value => ({ ...value, running: {} }))
    await $.command.register({
      name: 'tool-timings',
      description:
        'Open the tool timings panel. Args: "summary" prints it, "reset" clears this session',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flush($)
    loadedSession = ''
    sessionIdCache = ''

    return next(e)
  })

  on('command.run', { command: 'tool-timings' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const sessionId = await sessionIdOf($)
    await useSession($, sessionId)

    if (arg === 'reset') {
      await update($, log, () => blank(sessionId, Date.now()))
      await $.store.delete(storeKey(sessionId))
      return { text: 'Tool timings for this session were cleared.' }
    }
    if (arg === 'summary') {
      return { text: textSummary(await read($, log), await read($, sort)) }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Tool timings panel opened.' }
  })

  // Tool calls. The classic hook events are only watched here: hooking
  // `tool.call` would turn off moving a Bash call to the background.
  // PreToolUse fires before the permission check, so a "running" row may be
  // a call that waits for an answer. The time kept is PostToolUse's
  // `duration_ms`, which leaves the permission prompt out.
  on('classic.PreToolUse', async ($, e, next) => {
    const now = await $.clock.now()
    const sessionId = await sessionIdOf($)
    const tool = String(e.tool)
    await change($, sessionId, value => ({
      ...value,
      running: {
        ...value.running,
        [e.tool_use_id]: { tool, label: labelOf(e), startedAt: now },
      },
    }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    const now = await $.clock.now()
    await change($, await sessionIdOf($), value => {
      const started = value.running[e.tool_use_id]?.startedAt ?? now
      const ms = e.duration_ms ?? now - started
      return finishCall(
        value,
        e.tool_use_id,
        e.tool_name,
        labelOf(e.tool_input),
        ms,
        now,
        false,
        e.agent_type,
      )
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', async ($, e, next) => {
    const now = await $.clock.now()
    await change($, await sessionIdOf($), value => {
      const started = value.running[e.tool_use_id]?.startedAt ?? now
      const ms = e.duration_ms ?? now - started
      return finishCall(
        value,
        e.tool_use_id,
        e.tool_name,
        labelOf(e.tool_input),
        ms,
        now,
        true,
        e.agent_type,
      )
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  // A tool call that was refused never reaches PostToolUse.
  on('classic.PermissionDenied', async ($, e, next) => {
    const id = (e as { tool_use_id?: unknown }).tool_use_id
    if (typeof id === 'string') {
      await change($, await sessionIdOf($), value => {
        const { [id]: _gone, ...running } = value.running
        return { ...value, running }
      })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A call the person refused at the prompt never reaches PostToolUse. When
  // the main turn ends, nothing of its own is still running.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const sessionId = await sessionIdOf($)
      await change($, sessionId, value =>
        Object.keys(value.running).length === 0
          ? value
          : { ...value, running: {} },
      )
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Subagents: from the start of the spawn to the report.
  on('agent.spawn', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const result = await next(e)
    if (result.deny === undefined) {
      const sessionId = await sessionIdOf($)
      const agent: AgentRecord = {
        id: result.agentId ?? e.tool_use_id,
        type: e.subagentType,
        description: e.description,
        startedAt,
        status: 'running',
      }
      await change($, sessionId, value => ({
        ...value,
        agents: [...value.agents.filter(a => a.id !== agent.id), agent].slice(
          -KEEP_AGENTS,
        ),
      }))
    }

    return result
  }).catch(($, e, next) => next(e))

  on('agent.report', async ($, e, next) => {
    const now = await $.clock.now()
    const sessionId = await sessionIdOf($)
    await change($, sessionId, value =>
      endAgent(value, e.agentId, now, e.status, false),
    )

    return next(e)
  }).catch(($, e, next) => next(e))

  // Some runs (a workflow's agents, for one) raise no `agent.report`.
  on('classic.SubagentStop', async ($, e, next) => {
    const now = await $.clock.now()
    await change($, await sessionIdOf($), value =>
      endAgent(value, e.agent_id, now, 'completed', true),
    )

    return next(e)
  }).catch(($, e, next) => next(e))

  // ---------- the panel ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const value = await read($, log)
    const by = await read($, sort)
    const now = await $.clock.now()
    const columns = e.viewport?.columns ?? 60
    const isNarrow = columns < 52
    const num = isNarrow ? 7 : 9

    const tools = sortedTools(value, by)
    const running = Object.entries(value.running).sort(
      (a, b) => a[1].startedAt - b[1].startedAt,
    )
    const agents = [...value.agents].reverse()
    const isEmpty = value.totalCalls === 0 && agents.length === 0

    const cell = (text: string, width: number, bold = false) => (
      <Box width={width} justifyContent="flex-end">
        <Text bold={bold} tabular wrap="truncate-end">
          {text}
        </Text>
      </Box>
    )
    const heading = (text: string) => (
      <Box marginTop={1}>
        <Text bold>{text}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          <Text bold>{String(value.totalCalls)}</Text>
          <Text dimColor> calls · </Text>
          <Text bold>{formatMs(value.totalMs)}</Text>
          <Text dimColor> tool time · </Text>
          <Text bold>{String(value.agents.length)}</Text>
          <Text dimColor> subagents</Text>
        </Text>

        {isEmpty && (
          <Box marginTop={1}>
            <Text dimColor>
              No tool calls yet. Times show up here as Claude works.
            </Text>
          </Box>
        )}

        {running.length > 0 && heading('Running now')}
        {running.map(([id, r]) => (
          <Box key={`run-${id}`} flexDirection="row">
            <Box flexGrow={1} flexShrink={1}>
              <Text color="yellow" wrap="truncate-end">
                {r.tool}
                {r.label === '' ? '' : `  ${r.label}`}
              </Text>
            </Box>
            {cell(formatMs(Math.max(0, now - r.startedAt)), num)}
          </Box>
        ))}

        {tools.length > 0 && (
          <Box marginTop={1} flexDirection="row" justifyContent="space-between">
            <Text bold>By tool</Text>
            <Button
              key="sort"
              plain
              dimColor
              label={`sorted by ${SORT_LABEL[by]}`}
              onPress={() => update($, sort, s => NEXT_SORT[s])}
            />
          </Box>
        )}
        {tools.length > 0 && (
          <Box flexDirection="row">
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor>Tool</Text>
            </Box>
            <Box width={6} justifyContent="flex-end">
              <Text dimColor>Calls</Text>
            </Box>
            <Box width={num} justifyContent="flex-end">
              <Text dimColor>Total</Text>
            </Box>
            {!isNarrow && (
              <Box width={num} justifyContent="flex-end">
                <Text dimColor>Avg</Text>
              </Box>
            )}
            <Box width={num} justifyContent="flex-end">
              <Text dimColor>Max</Text>
            </Box>
          </Box>
        )}
        {tools.map(([tool, s]) => (
          <Box key={`tool-${tool}`} flexDirection="row">
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                {tool}
                {s.errors > 0 ? ` (${s.errors} failed)` : ''}
              </Text>
            </Box>
            {cell(String(s.count), 6)}
            {cell(formatMs(s.totalMs), num, true)}
            {!isNarrow && cell(formatMs(s.totalMs / s.count), num)}
            {cell(formatMs(s.maxMs), num)}
          </Box>
        ))}

        {agents.length > 0 && heading('Subagents')}
        {agents.map(a => (
          <Box key={`agent-${a.id}`} flexDirection="row">
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text bold>{a.type}</Text>
                <Text dimColor>{a.description === '' ? '' : `  ${a.description}`}</Text>
              </Text>
            </Box>
            {a.status === 'running' ? (
              <Box width={num + 8} justifyContent="flex-end">
                <Text color="yellow" tabular>
                  {`running ${formatMs(Math.max(0, now - a.startedAt))}`}
                </Text>
              </Box>
            ) : (
              <Box width={num + 8} justifyContent="flex-end">
                <Text
                  tabular
                  color={a.status === 'completed' ? undefined : 'red'}
                >
                  {`${a.status === 'completed' ? '' : `${a.status} `}${formatMs(a.ms ?? 0)}`}
                </Text>
              </Box>
            )}
          </Box>
        ))}

        {value.slowest.length > 0 && heading('Slowest calls')}
        {value.slowest.map((c, i) => (
          <Box key={`slow-${c.id}`} flexDirection="row">
            <Box width={3}>
              <Text dimColor>{`${i + 1}.`}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color={c.isError ? 'red' : undefined}>{c.tool}</Text>
                <Text dimColor>
                  {c.agentType === undefined ? '' : ` [${c.agentType}]`}
                  {c.label === '' ? '' : `  ${c.label}`}
                </Text>
              </Text>
            </Box>
            {cell(formatMs(c.ms), num, true)}
          </Box>
        ))}

        {!isEmpty && (
          <Box marginTop={1}>
            <Button
              key="reset"
              plain
              dimColor
              label="Clear this session's log"
              onPress={async () => {
                await update($, log, v => blank(v.sessionId, Date.now()))
                if (value.sessionId !== '') {
                  await $.store.delete(storeKey(value.sessionId))
                }
              }}
            />
          </Box>
        )}
      </Box>
    )
  })
}
