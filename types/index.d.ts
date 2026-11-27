/** Totals for one tool in this session. */
export type ToolStat = {
  count: number
  totalMs: number
  maxMs: number
  errors: number
}

/** One finished tool call. Only the slowest calls are kept. */
export type CallRecord = {
  id: string
  tool: string
  label: string
  ms: number
  at: number
  isError: boolean
  /** The subagent type the call ran in; absent on the main conversation. */
  agentType?: string
}

/** A tool call that has started and not finished yet. */
export type RunningCall = {
  tool: string
  label: string
  startedAt: number
  agentType?: string
  /** When a permission prompt for this call was shown to the person. */
  askedAt?: number
}

/** What Claude waited on the person for. */
export type WaitKind = 'question' | 'permission' | 'plan'

/** One time Claude waited for the person. */
export type WaitRecord = {
  id: string
  kind: WaitKind
  /** The question, or the tool and its command or file. */
  label: string
  ms: number
  at: number
  /** `declined`: the person said no to a permission prompt. */
  outcome: 'answered' | 'declined'
}

/** Totals for one kind of wait. */
export type WaitStat = {
  count: number
  totalMs: number
  maxMs: number
  /** How many were a "no"; absent in logs saved before it was counted. */
  declined?: number
}

/** The times Claude waited for the person in one session. */
export type WaitLog = {
  totalMs: number
  kinds: Partial<Record<WaitKind, WaitStat>>
  /** The most recent waits, newest last. */
  recent: WaitRecord[]
}

/** One subagent run. */
export type AgentRecord = {
  id: string
  type: string
  description: string
  startedAt: number
  ms?: number
  status: 'running' | 'completed' | 'failed' | 'stopped'
}

/** The time log of one session. */
export type TimingLog = {
  sessionId: string
  startedAt: number
  totalCalls: number
  totalMs: number
  tools: Record<string, ToolStat>
  slowest: CallRecord[]
  running: Record<string, RunningCall>
  agents: AgentRecord[]
  /** Absent in logs saved before waits were timed. */
  waits?: WaitLog
}

/** The numbers of the current (or last) turn of the main conversation. */
export type TurnStats = {
  startedAt: number
  /** Wall-clock length of the turn, set when it ends. */
  durationMs?: number
  calls: number
  toolMs: number
  agents: number
  slowest?: { tool: string; label: string; ms: number }
  isDone: boolean
  /** The person hid this turn's summary in the band. */
  isHidden: boolean
}

/** Whether the band above the prompt is used at all. */
export type BandMode = 'on' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'tool-timings': {
      log: Shaped<TimingLog>
      turn: TurnStats | null
      band: BandMode
      /** Whether emojis are drawn next to tools, headings and states. */
      emoji: BandMode
    }
  }
}
