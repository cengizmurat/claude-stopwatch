import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'tool-timings',
  component: 'Pane',
  requestId: 'tool-timings',
  props: {
    title: 'Tool timings',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// The id the kit gave the last call that went through `$.tool.call`.
let lastCallId = ''

function engine(on: On) {
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: { command: 'tool-timings' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('tool.call', (_, e) => {
    lastCallId = e.tool_use_id
    return { result: {} }
  })
}

test('a question is time spent waiting for you, not tool time', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.classic.PostToolUse({
    tool_name: 'AskUserQuestion',
    tool_use_id: 'q1',
    tool_input: { questions: [{ question: 'Public or private?' }] },
    tool_response: {},
    duration_ms: 45_000,
  })
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_use_id: 'b1',
    tool_input: { command: 'ls' },
    tool_response: {},
    duration_ms: 300,
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Waiting for you$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /· 🙋 45\.0s waiting for you$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Questions$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Public or private\?$/ })).toBeTruthy()
    // Tool time holds only the Bash call.
    expect(await ui.find({ type: 'Text', text: /^⏱ 1 call · 300ms tool time/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /AskUserQuestion/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a permission prompt counts from the prompt to the tool start', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm publish' })
  await clock.advance(500)
  await $.classic.PermissionRequest({
    tool_name: 'Bash',
    tool_input: { command: 'npm publish' },
  })

  // Waiting now: the running call says so.
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^💻 Bash · 🙋 waiting for you$/ })).toBeTruthy()
  await ui.unmount()

  // 20 seconds to say yes, then the tool runs for 2 seconds.
  await clock.advance(22_000)
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_use_id: lastCallId,
    tool_input: { command: 'npm publish' },
    tool_response: {},
    duration_ms: 2_000,
  })

  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Permission prompts$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Bash {2}npm publish$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /· 🙋 20\.0s waiting for you$/ })).toBeTruthy()
  await ui.unmount()
})

test('a "no" at a permission prompt is shown as declined', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await $.classic.PermissionRequest({
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' },
  })
  await clock.advance(5_000)
  await $.turn.complete({
    answer: '',
    durationMs: 6_000,
    isAborted: true,
    turnId: 't1',
    reason: 'aborted',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /declined$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /· 🙋 5\.0s waiting for you$/ })).toBeTruthy()
  await ui.unmount()
})

test('a question counts from the start of the call, not the tool run', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which version?',
        header: 'Version',
        multiSelect: false,
        options: [
          { label: '0.3.0', description: 'Minor' },
          { label: '1.0.0', description: 'Major' },
        ],
      },
    ],
  })
  // The person takes 8 seconds to answer; the tool itself then runs 2ms.
  await clock.advance(8_000)
  await $.classic.PostToolUse({
    tool_name: 'AskUserQuestion',
    tool_use_id: lastCallId,
    tool_input: {},
    tool_response: {},
    duration_ms: 2,
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /· 🙋 8\.0s waiting for you$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Which version\?$/ })).toBeTruthy()
  await ui.unmount()
})
