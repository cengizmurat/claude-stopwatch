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
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

function engine(on: On, sessionId = 'sess-1') {
  on('session.id', () => ({ value: sessionId }))
  on('command.register', () => ({ value: { command: 'tool-timings' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.SubagentStop', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
}

test('the panel shows totals per tool, subagents and the slowest tools', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const post = (id: string, tool: string, ms: number, command: string) =>
    $.classic.PostToolUse({
      tool_name: tool,
      tool_use_id: id,
      tool_input: { command },
      tool_response: {},
      duration_ms: ms,
    })
  await post('t1', 'Bash', 1500, 'npm test')
  await post('t2', 'Bash', 4500, 'npm run build')
  await post('t3', 'Read', 20, '')
  await $.classic.PostToolUseFailure({
    tool_name: 'Grep',
    tool_use_id: 't4',
    tool_input: { pattern: 'TODO' },
    error: 'boom',
    duration_ms: 300,
  })

  await $.agent.spawn({
    prompt: 'look around',
    description: 'Find the config',
    subagentType: 'Explore',
    tool_use_id: 'spawn-1',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
  })
  await clock.advance(65_000)
  await $.classic.SubagentStop({
    agent_id: 'agent-1',
    agent_type: 'Explore',
    stop_hook_active: false,
    agent_transcript_path: '',
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /^4$/ }))?.text).toBe('4')
    expect((await ui.find({ type: 'Text', text: /^6\.3s$/ }))?.text).toBe('6.3s')
    expect(await ui.find({ type: 'Text', text: /1 failed$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Find the config/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^1m 5s$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /npm run build/ })).toBeTruthy()
    expect((await ui.find({ key: 'sort' }))?.text).toBe('sorted by total time')
    await ui.unmount()
  }
})

test('the log is saved per session and comes back for that session', async ($, on) => {
  mock.clock(on, { now: 5_000 })
  mock.store(on, {
    'session:old': {
      shape: 'timing-log-1',
      value: {
        sessionId: 'old',
        startedAt: 1,
        totalCalls: 7,
        totalMs: 42_000,
        tools: { WebFetch: { count: 7, totalMs: 42_000, maxMs: 9_000, errors: 0 } },
        slowest: [],
        running: {},
        agents: [],
      },
    },
  })
  engine(on, 'old')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /^WebFetch$/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^42\.0s$/ }))?.text).toBe('42.0s')
  await ui.unmount()
})

test('a new session starts with an empty log', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  engine(on, 'fresh')

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /No tool calls yet/ })).toBeTruthy()
  await ui.unmount()
})

test('the sort button moves to the next order', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_use_id: 'x',
    tool_input: { command: 'ls' },
    tool_response: {},
    duration_ms: 10,
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sort' })

  expect((await ui.find({ key: 'sort' }))?.text).toBe('sorted by calls')
  await ui.unmount()
})

test('long MCP names and paths are shortened', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.classic.PostToolUse({
    tool_name: 'mcp__claude-code-remote__register_repo_root',
    tool_use_id: 'm1',
    tool_input: {},
    tool_response: {},
    duration_ms: 199,
  })
  await $.classic.PostToolUse({
    tool_name: 'Read',
    tool_use_id: 'r1',
    tool_input: { file_path: '/root/.claude/dev-mods/abc/tool-timings/hooks/register.tsx' },
    tool_response: {},
    duration_ms: 6,
  })
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_use_id: 'b1',
    tool_input: { command: 'git remote add origin https://github.com/a/b/c/d' },
    tool_response: {},
    duration_ms: 50,
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^register_repo_root$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^ claude-code-remote$/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /register\.tsx$/ }))?.text).toBe('…/hooks/register.tsx')
    expect(await ui.find({ type: 'Text', text: /^git remote add origin https:\/\/github\.com\/a\/b\/c\/d$/ })).toBeTruthy()
    await ui.unmount()
  }
})
