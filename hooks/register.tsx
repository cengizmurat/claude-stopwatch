import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  RenderElement,
  Timer,
} from 'claude-code'

import type {
  AgentRecord,
  BandMode,
  CallRecord,
  SortKey,
  TimingLog,
  ToolStat,
  TurnStats,
  WaitKind,
  WaitLog,
  WaitRecord,
} from '../types'

const PANE = 'tool-timings'
const TITLE = 'Tool timings'
const KEEP_SLOWEST = 10
const KEEP_AGENTS = 50
const KEEP_SESSIONS = 30
const KEEP_WAITS = 20
const SHOW_WAITS = 5

// Tools whose whole run is the person answering: their time is the
// person's, so it goes to "Waiting for you" and not to tool time.
const HUMAN_TOOLS: Record<string, WaitKind> = {
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
}
const FLUSH_MS = 2000

// Change the shape tag when TimingLog changes: it makes a new version of
// the code ignore what an older version stored.
const SHAPE = 'timing-log-1'

const log = atom({ plugin: 'tool-timings', key: 'log' } as const, blank(''), {
  shape: SHAPE,
})
const sort = atom({ plugin: 'tool-timings', key: 'sort' } as const, 'total')
const turn = atom(
  { plugin: 'tool-timings', key: 'turn' } as const,
  null as TurnStats | null,
)
const band = atom({ plugin: 'tool-timings', key: 'band' } as const, 'on' as BandMode)
const BAND_STORE_KEY = 'bandMode'
const emoji = atom({ plugin: 'tool-timings', key: 'emoji' } as const, 'on' as BandMode)
const EMOJI_STORE_KEY = 'emojiMode'
const BAND_ROWS = 3

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
    await refreshLive($)
  } catch {
    // A timing that fails to record must never stop the work it times.
  }
}

// ---------- live parts: the status line and the ticking clock ----------

// Ticks once a second while a call or a subagent runs, so the elapsed times
// in the band, the panel and the status line move. A reload stops it.
let ticker: Timer | undefined

function runningAgents(value: TimingLog): AgentRecord[] {
  return value.agents.filter(a => a.status === 'running')
}

function statusText(
  value: TimingLog,
  now: number,
  useEmoji: boolean,
): string | undefined {
  if (value.totalCalls === 0 && Object.keys(value.running).length === 0) {
    return undefined
  }
  const icon = (tool: string) => (useEmoji ? `${emojiOf(tool)} ` : '')
  const live = [
    ...Object.values(value.running).map(
      r =>
        `${icon(r.tool)}${splitToolName(r.tool).name} ${formatMs(Math.max(0, now - r.startedAt))}`,
    ),
    ...runningAgents(value).map(
      a =>
        `${useEmoji ? '🤖 ' : ''}${a.type} ${formatMs(Math.max(0, now - a.startedAt))}`,
    ),
  ]
  const totals = `${value.totalCalls} ${value.totalCalls === 1 ? 'call' : 'calls'} · ${formatMs(value.totalMs)} in tools`
  const top = value.slowest[0]
  const slowest =
    top === undefined
      ? ''
      : ` · ${useEmoji ? '🐢' : 'slowest'} ${splitToolName(top.tool).name} ${formatMs(top.ms)}`
  if (live.length === 0) return `⏱ ${totals}${slowest}`
  const shown = live.slice(0, 2).join(', ')
  const more = live.length > 2 ? ` +${live.length - 2}` : ''
  // With emojis each running item already starts with its tool's emoji.
  return `${useEmoji ? '' : '⏱ '}${shown}${more} │ ${totals}`
}

async function updateStatus($: Dollar): Promise<void> {
  const value = await read($, log)
  const useEmoji = (await read($, emoji)) === 'on'
  $.ui.status(statusText(value, await $.clock.now(), useEmoji))
}

async function refreshLive($: Dollar): Promise<void> {
  const value = await read($, log)
  const isRunning =
    Object.keys(value.running).length > 0 || runningAgents(value).length > 0
  if (isRunning && ticker === undefined) {
    ticker = $.clock.every(1000, () => {
      $.ui.invalidate('ui.render')
      void updateStatus($).catch(() => undefined)
    })
  } else if (!isRunning && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
  }
  await updateStatus($)
}

/** Adds a finished call to the numbers of the turn under way. */
async function countForTurn(
  $: Dollar,
  tool: string,
  label: string,
  ms: number,
): Promise<void> {
  if (HUMAN_TOOLS[tool] !== undefined) return
  try {
    await update($, turn, t => {
      if (t === null || t.isDone) return t
      const isSlowest = t.slowest === undefined || ms > t.slowest.ms
      return {
        ...t,
        calls: t.calls + 1,
        toolMs: t.toolMs + ms,
        slowest: isSlowest ? { tool, label, ms } : t.slowest,
      }
    })
  } catch {
    // Best effort, like every other count here.
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
      const line = shortenPaths(value.replace(/\s+/g, ' ').trim())
      return line.length > 120 ? `${line.slice(0, 119)}…` : line
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

function emptyWaits(): WaitLog {
  return { totalMs: 0, kinds: {}, recent: [] }
}

function addWait(value: TimingLog, wait: WaitRecord): TimingLog {
  const waits = value.waits ?? emptyWaits()
  const old = waits.kinds[wait.kind] ?? { count: 0, totalMs: 0, maxMs: 0 }
  return {
    ...value,
    waits: {
      totalMs: waits.totalMs + wait.ms,
      kinds: {
        ...waits.kinds,
        [wait.kind]: {
          count: old.count + 1,
          totalMs: old.totalMs + wait.ms,
          maxMs: Math.max(old.maxMs, wait.ms),
        },
      },
      recent: [...waits.recent.filter(w => w.id !== wait.id), wait].slice(
        -KEEP_WAITS,
      ),
    },
  }
}

/** The first question asked, or the plan, as one short line. */
function waitLabel(tool: string, input: unknown): string {
  if (tool === 'ExitPlanMode') return 'Plan approval'
  if (tool === 'AskUserQuestion' && typeof input === 'object' && input !== null) {
    const questions = (input as { questions?: unknown }).questions
    if (Array.isArray(questions) && questions.length > 0) {
      const first = questions[0] as { question?: unknown }
      const text = typeof first.question === 'string' ? first.question : ''
      const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : ''
      const line = text.replace(/\s+/g, ' ').trim()
      return `${line.length > 100 ? `${line.slice(0, 99)}…` : line}${more}`
    }
  }
  return labelOf(input)
}

function permissionLabel(tool: string, label: string): string {
  const name = splitToolName(tool).name
  return label === '' ? name : `${name}  ${label}`
}

/**
 * How long a finished call took. A question or a plan approval is answered
 * in its dialog before the tool runs, and the tool's own `duration_ms` (a
 * few ms) leaves the dialog out: so it counts from the start of the call.
 * Any other tool counts its own run, without the permission prompt.
 */
function callMs(
  value: TimingLog,
  id: string,
  tool: string,
  durationMs: number | undefined,
  now: number,
): number {
  const started = value.running[id]?.startedAt
  if (HUMAN_TOOLS[tool] !== undefined && started !== undefined) {
    return Math.max(0, now - started)
  }
  return durationMs ?? now - (started ?? now)
}

/**
 * A finished call: a question or plan approval becomes a wait; any other
 * call is tool time, plus a permission wait when a prompt was shown for it.
 */
function finishTool(
  value: TimingLog,
  id: string,
  tool: string,
  input: unknown,
  ms: number,
  now: number,
  isError: boolean,
  agentType: string | undefined,
): TimingLog {
  const run = value.running[id]
  const kind = HUMAN_TOOLS[tool]
  if (kind !== undefined) {
    const { [id]: _done, ...running } = value.running
    return addWait(
      { ...value, running },
      {
        id,
        kind,
        label: waitLabel(tool, input) || run?.label || '',
        ms,
        at: now,
        outcome: 'answered',
      },
    )
  }
  const label = labelOf(input)
  const done = finishCall(value, id, tool, label, ms, now, isError, agentType)
  if (run?.askedAt === undefined) return done
  // The tool ran for `ms` and ended now, so it started at `now - ms`: the
  // time before that, from the prompt on, was the person's.
  return addWait(done, {
    id: `${id}:permission`,
    kind: 'permission',
    label: permissionLabel(tool, label),
    ms: Math.max(0, now - ms - run.askedAt),
    at: now,
    outcome: 'answered',
  })
}

// ---------- drawing helpers ----------

/** `/a/b/c/d/file.ts` becomes `…/d/file.ts`, inside any text. */
function shortenPaths(text: string): string {
  // Not after a letter, ':' or '/', so `https://` links and `a/b` stay whole.
  return text.replace(/(?<![\w:/.~])(?:~|\.{1,2})?\/[^\s'"`]+/g, path => {
    const parts = path.split('/').filter(part => part !== '')
    return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : path
  })
}

/** `mcp__server__tool` is shown as the tool, then its server. */
function splitToolName(name: string): { name: string; server: string } {
  if (!name.startsWith('mcp__')) return { name, server: '' }
  const [, server = '', ...rest] = name.split('__')
  const tool = rest.join('__')
  return tool === '' ? { name, server: '' } : { name: tool, server }
}

const TOOL_EMOJI: Record<string, string> = {
  Bash: '💻',
  BashOutput: '💻',
  KillShell: '💻',
  Monitor: '💻',
  PowerShell: '💻',
  Read: '📖',
  NotebookRead: '📖',
  Write: '📝',
  Edit: '📝',
  MultiEdit: '📝',
  NotebookEdit: '📝',
  Grep: '🔍',
  Glob: '🔍',
  ToolSearch: '🔍',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Agent: '🤖',
  Task: '🤖',
  SendMessage: '🤖',
  Skill: '🧩',
  TodoWrite: '📋',
  TaskCreate: '📋',
  TaskUpdate: '📋',
  TaskList: '📋',
  TaskGet: '📋',
  Workflow: '🧭',
}

/** One emoji for a tool: by name, 🔌 for an MCP tool, 🔧 for the rest. */
function emojiOf(tool: string): string {
  if (tool.startsWith('mcp__')) return '🔌'
  return TOOL_EMOJI[tool] ?? '🔧'
}

/**
 * Theme color names, so the colors follow the person's light or dark theme.
 * Fast is under 2 seconds, slow is 15 seconds or more.
 */
const FAST_MS = 2_000
const SLOW_MS = 15_000

function speedColor(ms: number): 'success' | 'warning' | 'error' {
  if (ms < FAST_MS) return 'success'
  if (ms < SLOW_MS) return 'warning'
  return 'error'
}

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

const WAIT_KINDS: WaitKind[] = ['question', 'permission', 'plan']
const WAIT_LABEL: Record<WaitKind, string> = {
  question: 'Questions',
  permission: 'Permission prompts',
  plan: 'Plan approvals',
}
const WAIT_EMOJI: Record<WaitKind, string> = {
  question: '❓',
  permission: '🔐',
  plan: '📜',
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
    lines.push('', 'Slowest tools:')
    for (const c of value.slowest) {
      lines.push(`  ${formatMs(c.ms)}  ${c.tool}  ${c.label}`)
    }
  }
  const waits = value.waits
  if (waits !== undefined && waits.recent.length > 0) {
    lines.push('', `Waiting for you: ${formatMs(waits.totalMs)} in all.`)
    for (const kind of WAIT_KINDS) {
      const w = waits.kinds[kind]
      if (w === undefined) continue
      lines.push(
        `  ${WAIT_LABEL[kind]}: ${w.count} times, ${formatMs(w.totalMs)} total, avg ${formatMs(w.totalMs / w.count)}, max ${formatMs(w.maxMs)}`,
      )
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
    const savedBand = await $.store.get(BAND_STORE_KEY)
    await update($, band, () => (savedBand === 'off' ? 'off' : 'on'))
    const savedEmoji = await $.store.get(EMOJI_STORE_KEY)
    await update($, emoji, () => (savedEmoji === 'off' ? 'off' : 'on'))
    await $.command.register({
      name: 'tool-timings',
      description:
        'Open the tool timings panel. Args: "summary", "reset", "band on|off", "emoji on|off"',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    await refreshLive($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flush($)
    loadedSession = ''
    sessionIdCache = ''
    ticker?.cancel()
    ticker = undefined
    await update($, turn, () => null)
    $.ui.status(undefined)

    return next(e)
  })

  on('command.run', { command: 'tool-timings' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const sessionId = await sessionIdOf($)
    await useSession($, sessionId)

    if (arg === 'reset') {
      await update($, log, () => blank(sessionId, Date.now()))
      await update($, turn, () => null)
      await $.store.delete(storeKey(sessionId))
      await refreshLive($)
      return { text: 'Tool timings for this session were cleared.' }
    }
    if (arg === 'emoji off' || arg === 'emoji on') {
      const mode: BandMode = arg === 'emoji off' ? 'off' : 'on'
      await update($, emoji, () => mode)
      await $.store.set(EMOJI_STORE_KEY, mode)
      await updateStatus($)
      return {
        text:
          mode === 'off'
            ? 'Tool timings now draws no emojis. "/tool-timings emoji on" brings them back.'
            : 'Tool timings draws emojis again.',
      }
    }
    if (arg === 'band off' || arg === 'band on') {
      const mode: BandMode = arg === 'band off' ? 'off' : 'on'
      await update($, band, () => mode)
      await $.store.set(BAND_STORE_KEY, mode)
      return {
        text:
          mode === 'off'
            ? 'The tool timings band above the prompt is off. "/tool-timings band on" brings it back.'
            : 'The tool timings band above the prompt is on.',
      }
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
        [e.tool_use_id]: {
          tool,
          label: HUMAN_TOOLS[tool] === undefined ? labelOf(e) : waitLabel(tool, e),
          startedAt: now,
        },
      },
    }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    const now = await $.clock.now()
    let ms = 0
    await change($, await sessionIdOf($), value => {
      ms = callMs(value, e.tool_use_id, e.tool_name, e.duration_ms, now)
      return finishTool(
        value,
        e.tool_use_id,
        e.tool_name,
        e.tool_input,
        ms,
        now,
        false,
        e.agent_type,
      )
    })
    await countForTurn($, e.tool_name, labelOf(e.tool_input), ms)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', async ($, e, next) => {
    const now = await $.clock.now()
    let ms = 0
    await change($, await sessionIdOf($), value => {
      ms = callMs(value, e.tool_use_id, e.tool_name, e.duration_ms, now)
      return finishTool(
        value,
        e.tool_use_id,
        e.tool_name,
        e.tool_input,
        ms,
        now,
        true,
        e.agent_type,
      )
    })
    await countForTurn($, e.tool_name, labelOf(e.tool_input), ms)

    return next(e)
  }).catch(($, e, next) => next(e))

  // A permission prompt is shown to the person. It names no call id, so it
  // goes to the oldest running call of that tool and input not yet asked.
  on('classic.PermissionRequest', async ($, e, next) => {
    const now = await $.clock.now()
    const label = labelOf(e.tool_input)
    await change($, await sessionIdOf($), value => {
      const open = Object.entries(value.running)
        .filter(([, r]) => r.tool === e.tool_name && r.askedAt === undefined)
        .sort((a, b) => a[1].startedAt - b[1].startedAt)
      const match = open.find(([, r]) => r.label === label) ?? open[0]
      if (match === undefined) return value
      const [id, run] = match
      return {
        ...value,
        running: { ...value.running, [id]: { ...run, askedAt: now } },
      }
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

  // A new turn of the main conversation starts its own counts for the band.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const startedAt = await $.clock.now()
      await update($, turn, () => ({
        startedAt,
        calls: 0,
        toolMs: 0,
        agents: 0,
        isDone: false,
        isHidden: false,
      }))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A call the person refused at the prompt never reaches PostToolUse. When
  // the main turn ends, nothing of its own is still running.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const sessionId = await sessionIdOf($)
      const now = await $.clock.now()
      await change($, sessionId, value => {
        if (Object.keys(value.running).length === 0) return value
        // A prompt or question still open when the turn ended was turned
        // down (a "no" at a permission prompt ends the turn).
        let done: TimingLog = { ...value, running: {} }
        for (const [id, r] of Object.entries(value.running)) {
          const kind = HUMAN_TOOLS[r.tool]
          if (kind !== undefined) {
            done = addWait(done, {
              id,
              kind,
              label: kind === 'plan' ? 'Plan approval' : r.label,
              ms: Math.max(0, now - r.startedAt),
              at: now,
              outcome: 'declined',
            })
          } else if (r.askedAt !== undefined) {
            done = addWait(done, {
              id: `${id}:permission`,
              kind: 'permission',
              label: permissionLabel(r.tool, r.label),
              ms: Math.max(0, now - r.askedAt),
              at: now,
              outcome: 'declined',
            })
          }
        }
        return done
      })
      await update($, turn, t =>
        t === null ? t : { ...t, isDone: true, durationMs: e.durationMs },
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
      await update($, turn, t =>
        t === null || t.isDone ? t : { ...t, agents: t.agents + 1 },
      )
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

  // ---------- the band above the prompt ----------
  // While Claude works: what runs now, with live times, and this turn's
  // counts. After the turn: one line that sums the turn up.

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, band)) === 'off') return next(e)

    const value = await read($, log)
    const t = await read($, turn)
    const useEmoji = (await read($, emoji)) === 'on'
    const now = await $.clock.now()
    const width = Math.max(30, e.props.bodyColumns)
    const NUM = 8
    const icon = (glyph: string) => (useEmoji ? `${glyph} ` : '')

    const live = [
      ...Object.entries(value.running)
        .sort((a, b) => a[1].startedAt - b[1].startedAt)
        .map(([id, r]) => ({
          key: `call-${id}`,
          name: `${icon(emojiOf(r.tool))}${splitToolName(r.tool).name}`,
          detail: shortenPaths(r.label),
          ms: Math.max(0, now - r.startedAt),
        })),
      ...runningAgents(value).map(a => ({
        key: `agent-${a.id}`,
        name: `${icon('🤖')}${a.type}`,
        detail: a.description,
        ms: Math.max(0, now - a.startedAt),
      })),
    ]
    const isLive = live.length > 0 || (e.props.isWorking && t !== null && !t.isDone)
    const { Box, Text, Button } = $.ui.resolve(e)

    if (isLive) {
      const shown = live.slice(0, BAND_ROWS)

      return (
        <Box flexDirection="column" width={width}>
          <Box flexDirection="row" width={width}>
            <Box width={width - NUM} flexShrink={0} overflow="hidden">
              <Text wrap="truncate-end">
                <Text bold color="claude">{`${useEmoji ? '⏳' : '⏱'} Working`}</Text>
                {t === null ? (
                  ''
                ) : (
                  <Text>
                    <Text dimColor> · this turn </Text>
                    <Text color="suggestion">{`${t.calls} ${t.calls === 1 ? 'call' : 'calls'}`}</Text>
                    <Text dimColor>, </Text>
                    <Text color="claude">{formatMs(t.toolMs)}</Text>
                    <Text dimColor> in tools</Text>
                    {t.agents > 0 ? (
                      <Text>
                        <Text dimColor>, </Text>
                        <Text color="merged">{`${t.agents} ${t.agents === 1 ? 'subagent' : 'subagents'}`}</Text>
                      </Text>
                    ) : (
                      ''
                    )}
                  </Text>
                )}
              </Text>
            </Box>
            <Box width={NUM} flexShrink={0} justifyContent="flex-end">
              <Text dimColor tabular>
                {t === null ? '' : formatMs(Math.max(0, now - t.startedAt))}
              </Text>
            </Box>
          </Box>
          {shown.map(item => (
            <Box key={item.key} flexDirection="row" width={width}>
              <Box width={width - NUM} flexShrink={0} overflow="hidden">
                <Text wrap="truncate-end">
                  <Text>{`  ${item.name}`}</Text>
                  <Text dimColor>{item.detail === '' ? '' : `  ${item.detail}`}</Text>
                </Text>
              </Box>
              <Box width={NUM} flexShrink={0} justifyContent="flex-end">
                <Text bold color={speedColor(item.ms)} tabular>
                  {formatMs(item.ms)}
                </Text>
              </Box>
            </Box>
          ))}
          {live.length > shown.length && (
            <Text dimColor>{`  +${live.length - shown.length} more running`}</Text>
          )}
        </Box>
      )
    }

    const hasSummary =
      t !== null && t.isDone && !t.isHidden && (t.calls > 0 || t.agents > 0)
    if (!hasSummary) return next(e)

    const slow = t.slowest

    return (
      <Box flexDirection="row" width={width} alignItems="center">
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color="success">{`${useEmoji ? '✅' : '⏱'} Last turn `}</Text>
            <Text bold color="success">{formatMs(t.durationMs ?? 0)}</Text>
            <Text dimColor> · </Text>
            <Text color="suggestion">{`${t.calls} ${t.calls === 1 ? 'call' : 'calls'}`}</Text>
            <Text dimColor> · </Text>
            <Text color="claude">{formatMs(t.toolMs)}</Text>
            <Text dimColor> in tools</Text>
            {t.agents > 0 ? (
              <Text>
                <Text dimColor> · </Text>
                <Text color="merged">{`${t.agents} ${t.agents === 1 ? 'subagent' : 'subagents'}`}</Text>
              </Text>
            ) : (
              ''
            )}
            {slow === undefined ? (
              ''
            ) : (
              <Text>
                <Text dimColor>{` · ${useEmoji ? '🐢' : 'slowest'} `}</Text>
                <Text>{splitToolName(slow.tool).name}</Text>
                <Text bold color={speedColor(slow.ms)}>{` ${formatMs(slow.ms)}`}</Text>
                <Text dimColor>
                  {slow.label === '' ? '' : `  ${shortenPaths(slow.label)}`}
                </Text>
              </Text>
            )}
          </Text>
        </Box>
        <Box flexShrink={0} flexDirection="row" gap={1} marginLeft={1}>
          <Button
            key="band-details"
            plain
            label="Details"
            onPress={async () => {
              await $.ui.open({ id: PANE, title: TITLE })
            }}
          />
          <Button
            key="band-hide"
            plain
            dimColor
            label="Hide"
            onPress={() =>
              update($, turn, v => (v === null ? v : { ...v, isHidden: true }))
            }
          />
        </Box>
      </Box>
    )
  })

  // ---------- the panel ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const value = await read($, log)
    const by = await read($, sort)
    const useEmoji = (await read($, emoji)) === 'on'
    const now = await $.clock.now()
    const icon = (glyph: string) => (useEmoji ? `${glyph} ` : '')

    // Every column has a fixed width taken from the panel's own width, so a
    // long name is cut with "…" and never pushes the numbers out of line.
    const width = Math.max(32, (e.props.bodyColumns ?? e.viewport?.columns ?? 60) - 2)
    const CALLS = 6
    const NUM = 8
    const SHARE = 6
    const RANK = 4
    const showAvg = width >= 56
    const showShare = width >= 66
    const nameWidth =
      width - CALLS - NUM * (showAvg ? 3 : 2) - (showShare ? SHARE : 0)
    const kindWidth = width - CALLS - NUM * (showAvg ? 3 : 2)
    const waits = value.waits

    const tools = sortedTools(value, by)
    const running = Object.entries(value.running).sort(
      (a, b) => a[1].startedAt - b[1].startedAt,
    )
    const agents = [...value.agents].reverse()
    const isEmpty =
      value.totalCalls === 0 &&
      agents.length === 0 &&
      (value.waits?.recent.length ?? 0) === 0 &&
      running.length === 0

    const num = (
      text: string,
      cells: number,
      style: { bold?: boolean; dim?: boolean; color?: string } = {},
    ) => (
      <Box width={cells} flexShrink={0} justifyContent="flex-end">
        <Text
          tabular
          bold={style.bold}
          dimColor={style.dim}
          color={style.color}
          wrap="truncate-end"
        >
          {text}
        </Text>
      </Box>
    )
    const toolName = (tool: string, color?: string) => {
      const parts = splitToolName(tool)
      return (
        <Text>
          {icon(emojiOf(tool))}
          <Text color={color}>{parts.name}</Text>
          {parts.server === '' ? '' : <Text dimColor>{` ${parts.server}`}</Text>}
        </Text>
      )
    }
    const detail = (key: string, text: string, indent: number) =>
      text === '' ? null : (
        <Box key={key} width={width} paddingLeft={indent} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {shortenPaths(text)}
          </Text>
        </Box>
      )
    const heading = (
      glyph: string,
      title: string,
      right: RenderElement | null = null,
    ) => (
      <Box
        marginTop={1}
        width={width}
        flexDirection="row"
        justifyContent="space-between"
      >
        <Text bold color="claude">{`${icon(glyph)}${title}`}</Text>
        {right}
      </Box>
    )
    const AGENT_STATE: Record<AgentRecord['status'], { text: string; glyph: string; color: string }> = {
      running: { text: 'running', glyph: '⏳', color: 'warning' },
      completed: { text: 'done', glyph: '✅', color: 'success' },
      failed: { text: 'failed', glyph: '❌', color: 'error' },
      stopped: { text: 'stopped', glyph: '🛑', color: 'error' },
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text wrap="wrap">
          <Text>{icon('⏱')}</Text>
          <Text bold color="suggestion">{String(value.totalCalls)}</Text>
          <Text dimColor>{value.totalCalls === 1 ? ' call · ' : ' calls · '}</Text>
          <Text bold color="claude">{formatMs(value.totalMs)}</Text>
          <Text dimColor> tool time · </Text>
          <Text bold color="merged">{String(value.agents.length)}</Text>
          <Text dimColor>{value.agents.length === 1 ? ' subagent · ' : ' subagents · '}</Text>
          <Text>{icon('🙋')}</Text>
          <Text bold color="permission">{formatMs(waits?.totalMs ?? 0)}</Text>
          <Text dimColor> waiting for you</Text>
        </Text>

        {isEmpty && (
          <Box marginTop={1}>
            <Text dimColor>
              No tool calls yet. Times show up here as Claude works.
            </Text>
          </Box>
        )}

        {running.length > 0 && heading('⚡', 'Running now')}
        {running.map(([id, r]) => {
          const ms = Math.max(0, now - r.startedAt)
          return (
            <Box key={`run-${id}`} flexDirection="column">
              <Box flexDirection="row" width={width}>
                <Box width={width - NUM} flexShrink={0} overflow="hidden">
                  <Text wrap="truncate-end">
                    {toolName(r.tool)}
                    {HUMAN_TOOLS[r.tool] !== undefined || r.askedAt !== undefined ? (
                      <Text color="permission">{` · ${icon('🙋')}waiting for you`}</Text>
                    ) : (
                      ''
                    )}
                  </Text>
                </Box>
                {num(formatMs(ms), NUM, { bold: true, color: speedColor(ms) })}
              </Box>
              {detail(`run-d-${id}`, r.label, 3)}
            </Box>
          )
        })}

        {tools.length > 0 &&
          heading(
            '🧰',
            'By tool',
            <Button
              key="sort"
              plain
              dimColor
              label={`sorted by ${SORT_LABEL[by]}`}
              onPress={() => update($, sort, s => NEXT_SORT[s])}
            />,
          )}
        {tools.length > 0 && (
          <Box flexDirection="row" width={width}>
            <Box width={nameWidth} flexShrink={0}>
              <Text dimColor>Tool</Text>
            </Box>
            {num('Calls', CALLS, { dim: true })}
            {num('Total', NUM, { dim: true })}
            {showShare && num('Share', SHARE, { dim: true })}
            {showAvg && num('Avg', NUM, { dim: true })}
            {num('Max', NUM, { dim: true })}
          </Box>
        )}
        {tools.map(([tool, s]) => {
          const avg = s.totalMs / s.count
          return (
            <Box key={`tool-${tool}`} flexDirection="row" width={width}>
              <Box width={nameWidth} flexShrink={0} overflow="hidden">
                <Text wrap="truncate-end">
                  {toolName(tool)}
                  {s.errors > 0 ? (
                    <Text color="error">{` ${useEmoji ? '❌ ' : ''}${s.errors} failed`}</Text>
                  ) : (
                    ''
                  )}
                </Text>
              </Box>
              {num(String(s.count), CALLS, { color: 'suggestion' })}
              {num(formatMs(s.totalMs), NUM, { bold: true, color: 'claude' })}
              {showShare &&
                num(
                  `${value.totalMs === 0 ? 0 : Math.round((s.totalMs / value.totalMs) * 100)}%`,
                  SHARE,
                  { dim: true },
                )}
              {showAvg && num(formatMs(avg), NUM, { color: speedColor(avg) })}
              {num(formatMs(s.maxMs), NUM, { color: speedColor(s.maxMs) })}
            </Box>
          )
        })}

        {agents.length > 0 && heading('🤖', 'Subagents')}
        {agents.map(a => {
          const state = AGENT_STATE[a.status]
          const ms = a.ms ?? Math.max(0, now - a.startedAt)
          return (
            <Box key={`agent-${a.id}`} flexDirection="column">
              <Box flexDirection="row" width={width}>
                <Box width={width - NUM - 11} flexShrink={0} overflow="hidden">
                  <Text bold wrap="truncate-end">
                    {a.type}
                  </Text>
                </Box>
                <Box width={11} flexShrink={0} justifyContent="flex-end">
                  <Text color={state.color}>
                    {`${icon(state.glyph)}${state.text}`}
                  </Text>
                </Box>
                {num(formatMs(ms), NUM, { bold: true, color: speedColor(ms) })}
              </Box>
              {detail(`agent-d-${a.id}`, a.description, 2)}
            </Box>
          )
        })}

        {waits !== undefined && waits.recent.length > 0 && (
          <Box flexDirection="column">
            {heading('🙋', 'Waiting for you')}
            <Box flexDirection="row" width={width}>
              <Box width={kindWidth} flexShrink={0}>
                <Text dimColor>Kind</Text>
              </Box>
              {num('Times', CALLS, { dim: true })}
              {num('Total', NUM, { dim: true })}
              {showAvg && num('Avg', NUM, { dim: true })}
              {num('Max', NUM, { dim: true })}
            </Box>
            {WAIT_KINDS.map(kind => {
              const w = waits.kinds[kind]
              if (w === undefined) return null
              return (
                <Box key={`wait-kind-${kind}`} flexDirection="row" width={width}>
                  <Box width={kindWidth} flexShrink={0} overflow="hidden">
                    <Text wrap="truncate-end">
                      {`${icon(WAIT_EMOJI[kind])}${WAIT_LABEL[kind]}`}
                    </Text>
                  </Box>
                  {num(String(w.count), CALLS, { color: 'suggestion' })}
                  {num(formatMs(w.totalMs), NUM, { bold: true, color: 'permission' })}
                  {showAvg && num(formatMs(w.totalMs / w.count), NUM)}
                  {num(formatMs(w.maxMs), NUM)}
                </Box>
              )
            })}
            <Box marginTop={1}>
              <Text dimColor>Most recent</Text>
            </Box>
            {[...waits.recent]
              .reverse()
              .slice(0, SHOW_WAITS)
              .map(w => (
                <Box key={`wait-${w.id}`} flexDirection="column">
                  <Box flexDirection="row" width={width}>
                    <Box width={width - NUM} flexShrink={0} overflow="hidden">
                      <Text wrap="truncate-end">
                        {`${icon(WAIT_EMOJI[w.kind])}${WAIT_LABEL[w.kind].replace(/s$/, '')}`}
                        {w.outcome === 'declined' ? (
                          <Text color="error">{` · ${icon('🚫')}declined`}</Text>
                        ) : (
                          ''
                        )}
                      </Text>
                    </Box>
                    {num(formatMs(w.ms), NUM, { bold: true, color: 'permission' })}
                  </Box>
                  {detail(`wait-d-${w.id}`, w.label, useEmoji ? 3 : 2)}
                </Box>
              ))}
          </Box>
        )}

        {value.slowest.length > 0 && heading('🐢', 'Slowest tools')}
        {value.slowest.map((c, i) => (
          <Box key={`slow-${c.id}`} flexDirection="column">
            <Box flexDirection="row" width={width}>
              <Box width={RANK} flexShrink={0}>
                <Text dimColor tabular>{`${i + 1}.`}</Text>
              </Box>
              <Box width={width - RANK - NUM} flexShrink={0} overflow="hidden">
                <Text wrap="truncate-end">
                  {toolName(c.tool, c.isError ? 'error' : undefined)}
                  {c.agentType === undefined ? (
                    ''
                  ) : (
                    <Text dimColor>{` in ${c.agentType}`}</Text>
                  )}
                </Text>
              </Box>
              {num(formatMs(c.ms), NUM, { bold: true, color: speedColor(c.ms) })}
            </Box>
            {detail(`slow-d-${c.id}`, c.label, RANK + (useEmoji ? 3 : 0))}
          </Box>
        ))}

        {!isEmpty && (
          <Box marginTop={1}>
            <Button
              key="reset"
              plain
              dimColor
              label={`${icon('🧹')}Clear this session's log`}
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
