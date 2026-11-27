import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

const PANE = {
  plugin: 'tool-timings',
  component: 'Pane',
  requestId: 'tool-timings',
  props: {
    title: 'Tool timings',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'tool-timings',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

function engine(on: On, stepMs: (e: TurnStepInput) => number) {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: { command: 'tool-timings' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.PostToolUse', () => ({}))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('classic.SubagentStop', () => ({}))
  // The model: answers after `stepMs` of the mocked clock.
  on('turn.step', async function* (_, e) {
    await clock.sleep(stepMs(e))
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: null,
    }
  })
  return clock
}

/** Runs one model request while the clock moves `ms` on. */
async function step(
  $: Engine,
  clock: ReturnType<typeof mock.clock>,
  input: TurnStepInput,
  ms: number,
) {
  const stream = $.turn.step(input)
  const done = (async () => {
    for await (const _ of stream) {
      // The test only times the request.
    }
  })()
  await clock.advance(ms)
  await done
}

test("the main agent's model requests count as thinking", async ($, on) => {
  const clock = engine(on, () => 4_000)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await step($, clock, { turnId: 't1', index: 0, model: 'opus', messageCount: 1 }, 4_000)
  await step($, clock, { turnId: 't1', index: 1, model: 'opus', messageCount: 3 }, 4_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /🧠 8\.0s thinking/ })).toBeTruthy()
  await ui.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /🧠 8\.0s thinking/ })).toBeTruthy()
  await band.unmount()
})

test("a subagent's model requests are not thinking: it counts as a whole", async ($, on) => {
  const clock = engine(on, () => 5_000)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn({
    prompt: 'look',
    description: 'Find the config',
    subagentType: 'Explore',
    tool_use_id: 'a1',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
  })
  // Inside the subagent: a model request and a tool call.
  await step(
    $,
    clock,
    { turnId: 'sub-t', index: 0, model: 'haiku', messageCount: 1, agentId: 'agent-1' },
    5_000,
  )
  await $.classic.PostToolUse({
    tool_name: 'Grep',
    tool_use_id: 'g1',
    tool_input: { pattern: 'config' },
    tool_response: {},
    duration_ms: 2_000,
    agent_id: 'agent-1',
    agent_type: 'Explore',
  })
  await clock.advance(10_000)
  // The Agent tool call that held the subagent: its time is the subagent's.
  await $.classic.PostToolUse({
    tool_name: 'Agent',
    tool_use_id: 'a1',
    tool_input: { description: 'Find the config' },
    tool_response: {},
    duration_ms: 15_000,
  })
  await $.classic.SubagentStop({
    agent_id: 'agent-1',
    agent_type: 'Explore',
    stop_hook_active: false,
    agent_transcript_path: '',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // No tool time and no thinking from inside the subagent, nor its Agent call.
  expect(await ui.find({ type: 'Text', text: /^⏱ 0 calls · 0ms tool time · 🧠 0ms thinking/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Grep/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^🤖 Agent$/ })).toBeUndefined()
  // The subagent, once, as a whole.
  expect(await ui.find({ type: 'Text', text: /🤖 1 subagent 15\.0s/ })).toBeTruthy()
  await ui.unmount()
})
