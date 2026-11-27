import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

function bandOf(isWorking: boolean) {
  return {
    plugin: 'tool-timings',
    component: 'AbovePrompt',
    requestId: 'band',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking,
      maxRows: 10,
      bodyColumns: 90,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  } as const
}

function engine(on: On) {
  const statuses: Array<string | undefined> = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: { command: 'tool-timings' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.PostToolUse', () => ({}))
  on('tool.call', () => ({ result: {} }))
  return statuses
}

test('while Claude works, the band and status line show what runs', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  const statuses = engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  await $.classic.PostToolUse({
    tool_name: 'Read',
    tool_use_id: 'r1',
    tool_input: { file_path: 'a.ts' },
    tool_response: {},
    duration_ms: 400,
  })
  // A call that starts and is still running.
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.advance(12_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...bandOf(true), surface })
    expect(await ui.find({ type: 'Text', text: /^⏳ Working/ })).toBeTruthy()
    expect(
      await ui.find({ type: 'Text', text: /this turn 1 call, 400ms in tools/ }),
    ).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^ {2}💻 Bash {2}npm test$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^12\.0s$/ })).toBeTruthy()
    await ui.unmount()
  }

  expect(statuses.at(-1)).toBe('💻 Bash 12.0s │ 1 call · 400ms in tools')
})

test('after the turn, the band sums it up and can be hidden', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  const statuses = engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  for (const [id, ms, command] of [
    ['b1', 31_000, 'npm run build'],
    ['b2', 2_000, 'ls'],
  ] as const) {
    await $.classic.PostToolUse({
      tool_name: 'Bash',
      tool_use_id: id,
      tool_input: { command },
      tool_response: {},
      duration_ms: ms,
    })
  }
  await $.turn.complete({
    answer: 'done',
    durationMs: 72_000,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...bandOf(false), surface })
    expect(await ui.find({ type: 'Text', text: /^✅ Last turn 1m 12s/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /2 calls · 33\.0s in tools/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /🐢 Bash 31\.0s {2}npm run build/ })).toBeTruthy()
    expect((await ui.find({ key: 'band-details' }))?.text).toBe('Details')
    await ui.unmount()
  }

  expect(statuses.at(-1)).toBe('⏱ 2 calls · 33.0s in tools · 🐢 Bash 31.0s')

  const ui = await $.ui.mount({ ...bandOf(false), surface: 'desktop' })
  await ui.press({ key: 'band-hide' })
  expect(await ui.find({ type: 'Text', text: /Last turn/ })).toBeUndefined()
  await ui.unmount()
})

test('"/tool-timings band off" turns the band off', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_use_id: 'b1',
    tool_input: { command: 'ls' },
    tool_response: {},
    duration_ms: 100,
  })
  await $.command.run({
    command: 'tool-timings',
    args: 'band off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  const ui = await $.ui.mount({ ...bandOf(true), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Working/ })).toBeUndefined()
  await ui.unmount()
})

test('"/tool-timings emoji off" draws plain text', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  mock.store(on)
  const statuses = engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_use_id: 'b1',
    tool_input: { command: 'ls' },
    tool_response: {},
    duration_ms: 100,
  })
  await $.command.run({
    command: 'tool-timings',
    args: 'emoji off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  expect(statuses.at(-1)).toBe('⏱ 1 call · 100ms in tools · slowest Bash 100ms')
  const ui = await $.ui.mount({
    plugin: 'tool-timings',
    component: 'Pane',
    requestId: 'tool-timings',
    surface: 'desktop',
    props: {
      title: 'Tool timings',
      isFocused: false,
      bodyColumns: 70,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
  expect(await ui.find({ type: 'Text', text: /^By tool$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /💻/ })).toBeUndefined()
  await ui.unmount()
})
