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
}

export type SortKey = 'total' | 'count' | 'max'

declare module 'claude-code' {
  interface PluginState {
    'tool-timings': {
      log: Shaped<TimingLog>
      sort: SortKey
    }
  }
}
