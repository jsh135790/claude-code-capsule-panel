import type { On, RenderPropsOf, UiPane } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Usage',
  isFocused: false,
  bodyColumns: 46,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const PANE = { plugin: 'capsule-panel', component: 'Pane', props: PANE_PROPS, requestId: 'capsule-panel' } as const
const BAND = { plugin: 'capsule-panel', component: 'AbovePrompt', props: BAND_PROPS } as const
const WORKING_BAND = { ...BAND, props: { ...BAND_PROPS, isWorking: true } } as const

const GREEN = '#a6e3a1'
const RED = '#f38ba8'
const MAUVE = '#cba6f7'
const MINUTE = 60_000

// Nerd Font glyphs live in the private use areas; nothing else here does.
const PUA = new RegExp(
  `[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xf8ff)}]|[${String.fromCodePoint(0xf0000)}-${String.fromCodePoint(0xffffd)}]`,
  'u',
)
// block elements: sparkline bars and pixel art, none of which the band draws now
const BLOCKS = /[▀-▟]/

// Hooks beneath the plugin that stand for the engine, so every event the
// plugin passes on with next(e) settles in the test host.
const engine = (on: On, panes: UiPane[] = []) => {
  const closed: string[] = []
  const toasts: string[] = []
  const played: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] },
  }))
  on('session.model', () => ({ value: 'claude-test-1' }))
  on('session.cwd', () => ({ value: 'C:/work' }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => ({
    value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))
  on('ui.panes', () => ({ value: panes }))
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', ($, e) => {
    played.push(e.clip.asset ?? e.clip.url ?? 'bytes')
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box' }))
  return { closed, toasts, played }
}

const measure = (percent: number, extra: { costUsd?: number; limits?: { pct: number; resetsAt: string }[] } = {}) => ({
  context: { tokens: percent * 10_000, window: 1_000_000, percent },
  rateLimits: (extra.limits ?? []).map(l => ({ kind: 'five_hour', percentUsed: l.pct, resetsAt: l.resetsAt })),
  cost: extra.costUsd === undefined ? undefined : { usd: extra.costUsd },
  changed: ['context' as const],
})

const complete = (turnId: string) => ({
  answer: '',
  durationMs: 1000,
  isAborted: false,
  turnId,
  reason: 'answer' as const,
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model: 'claude-test-1',
  },
})

test('the pane draws its sections on every surface it is placed on', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport: { columns: 160, rows: 40, isFullscreen: true } })
    const title = surface === 'terminal' ? await ui.find({ type: 'Text', text: /USAGE/ }) : await ui.find({ type: 'Svg' })
    expect(title).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CONTEXT/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no activity yet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /LIMITS/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the terminal gets Nerd Font glyphs and the desktop plain symbols', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await terminal.findAll({ type: 'Text' })).some(t => PUA.test(t.text))).toBe(true)
  await terminal.unmount()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desktop.findAll({ type: 'Text' })).some(t => PUA.test(t.text))).toBe(false)
  expect(await desktop.find({ type: 'Text', text: /◧ CONTEXT/ })).toBeDefined()
  await desktop.unmount()
})

test('the desktop draws each capsule as an SVG with round ends', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const capsule = await ui.find({ type: 'Svg' })
  expect(capsule?.props.alt).toBe('USAGE')
  expect(capsule?.props.height).toBe(17)
  const source = String(capsule?.props.source)
  expect(source).toMatch(/<rect [^>]*rx="8.5" fill="#cba6f7"/)
  expect(source).toMatch(/font-size="12"/)
  expect(source).toMatch(/>USAGE<\/text>/)
  // the icon is a shape, not a glyph from whatever font the surface has
  expect(source).toMatch(/<path d="M5 0\.5L6\.1/)
  expect(source).not.toMatch(/✦/)
  expect(capsule?.props.isInteractive).toBe(false)
  await ui.unmount()
})

test('icons: unicode drops the Nerd Font glyphs in the terminal too', { options: { icons: 'unicode' } }, async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text' })).some(t => PUA.test(t.text))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /◧ CONTEXT/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^☰ $/ })).toBeDefined()
  await ui.unmount()
})

test('the context figure follows the thresholds once the count-up settles', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.measure(measure(43))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^43%$/ }))?.props.color).toBe(GREEN)

  await $.session.measure(measure(92))
  await clock.advance(1_000)
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /^92%$/ }))?.props.color).toBe(RED)
  await ui.unmount()
})

test('a completed turn adds up tokens and the cache hit rate', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  await $.turn.complete({
    answer: '',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 91_000,
      cache_creation_input_tokens: 8_000,
      model: 'claude-test-1',
    },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^91% hit$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↑ 1k {2}↓ 500/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 turn$/ })).toBeDefined()
  await ui.unmount()
})

test('without rate limits the cost row shows the hourly burn instead', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 0 })
  await $.session.measure(measure(10, { costUsd: 1 }))
  await clock.set(30 * MINUTE)
  await $.session.measure(measure(12, { costUsd: 2 }))
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^\$2\.00$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$4\.00\/h/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /LIMITS/ })).toBeUndefined()
  await ui.unmount()
})

test('a limit burning faster than its window warns how long is left', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 0 })
  const farReset = new Date(5 * 60 * MINUTE).toISOString()
  await $.session.measure(measure(10, { limits: [{ pct: 10, resetsAt: farReset }] }))
  await clock.set(10 * MINUTE)
  await $.session.measure(measure(10, { limits: [{ pct: 20, resetsAt: farReset }] }))
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /LIMITS/ })).toBeDefined()
  // 10 points in 10 minutes leaves 80 points: 1h20m, well before the reset
  expect((await ui.find({ type: 'Text', text: /~1h20m/ }))?.props.color).toBe(RED)
  await ui.unmount()
})

test('that forecast also raises one toast, and only one, per window', async ($, on) => {
  const { toasts } = engine(on)
  const clock = mock.clock(on, { now: 0 })
  const farReset = new Date(5 * 60 * MINUTE).toISOString()
  await $.session.measure(measure(10, { limits: [{ pct: 10, resetsAt: farReset }] }))
  await clock.settle()
  expect(toasts).toEqual([])

  await clock.set(10 * MINUTE)
  await $.session.measure(measure(10, { limits: [{ pct: 20, resetsAt: farReset }] }))
  await clock.settle()
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/5h limit on pace to run out in ~1h20m, before it resets in 4h50m/)

  await clock.set(20 * MINUTE)
  await $.session.measure(measure(10, { limits: [{ pct: 30, resetsAt: farReset }] }))
  await clock.settle()
  expect(toasts.length).toBe(1)
})

test('a limit that resets before it fills is marked safe', async ($, on) => {
  const { toasts } = engine(on)
  const clock = mock.clock(on, { now: 0 })
  const soonReset = new Date(30 * MINUTE).toISOString()
  await $.session.measure(measure(10, { limits: [{ pct: 10, resetsAt: soonReset }] }))
  await clock.set(10 * MINUTE)
  await $.session.measure(measure(10, { limits: [{ pct: 20, resetsAt: soonReset }] }))
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /✓/ }))?.props.color).toBe(GREEN)
  expect(await ui.find({ type: 'Text', text: /~1h20m/ })).toBeUndefined()
  expect(toasts).toEqual([])
  await ui.unmount()
})

test('tool calls land in the activity list with their time and outcome', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', async ($, e) => {
    if (e.tool === 'Bash') {
      await clock.sleep(1_500)
      return { isError: true, result: 'exit 1', text: 'exit 1' }
    }
    return { result: { ok: true }, text: 'ok' }
  })

  const pending = $.tool.call({ tool: 'Bash', command: 'npm test', description: 'run tests' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /npm test/ })).toBeDefined()

  await clock.advance(1_500)
  await pending
  await $.tool.call({ tool: 'Read', file_path: 'C:/work/src/register.tsx' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /^register\.tsx$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^✗ $/ }))?.props.color).toBe(RED)
  expect(await ui.find({ type: 'Text', text: /1\.5s/ })).toBeDefined()
  await ui.unmount()
})

test('a todo list shows its progress and the step under way', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Write types', status: 'completed', activeForm: 'Writing types' },
      { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' },
    ],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /→ Writing tests/ })).toBeDefined()
  await ui.unmount()
})

test('the band stays out of the way until a turn is working', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', async () => {
    await clock.sleep(5_000)
    return { result: {}, text: 'ok' }
  })

  const idle = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await idle.find({ type: 'Text', text: /tok\/s|thinking|Bash/ })).toBeUndefined()
  await idle.unmount()

  await $.turn.start({ text: 'go', turnId: 't1' })
  void $.tool.call({ tool: 'Bash', command: 'npm run build' })
  await clock.advance(240)
  const ui = await $.ui.mount({ ...WORKING_BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Bash/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /npm run build/ })).toBeDefined()
  await ui.unmount()
})

test('the band leads with the phase pill and draws no pixel art', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(240)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...WORKING_BAND, surface })
    expect((await ui.findAll({ type: 'Text' })).some(t => BLOCKS.test(t.text))).toBe(false)
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /thinking/ })).toBeDefined()
    } else {
      expect((await ui.findAll({ type: 'Text' })).some(t => PUA.test(t.text))).toBe(false)
      const capsule = await ui.find({ type: 'Svg' })
      expect(capsule?.props.alt).toBe('thinking')
      expect(String(capsule?.props.source)).toMatch(new RegExp(`fill="${MAUVE}"[^]*>thinking<`))
    }
    await ui.unmount()
  }
})

test('a running tool spins the band capsule, which keeps its width', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', async () => {
    await clock.sleep(5_000)
    return { result: {}, text: 'ok' }
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(240)
  const terminal = await $.ui.mount({ ...WORKING_BAND, surface: 'terminal' })
  const desktop = await $.ui.mount({ ...WORKING_BAND, surface: 'desktop' })
  const terminalCapsule = async () =>
    (await terminal.findAll({ type: 'Text' })).find(t => t.props.backgroundColor !== undefined)?.text ?? ''

  const thinkingText = await terminalCapsule()
  const thinkingWidth = (await desktop.find({ type: 'Svg' }))?.props.width

  void $.tool.call({ tool: 'Bash', command: 'npm run build' })
  await clock.advance(120)
  await terminal.redraw()
  await desktop.redraw()
  const first = await terminalCapsule()
  const firstSvg = String((await desktop.find({ type: 'Svg' }))?.props.source)
  expect(first).toMatch(/Bash/)
  expect(Array.from(first).length).toBe(Array.from(thinkingText).length)
  expect((await desktop.find({ type: 'Svg' }))?.props.width).toBe(thinkingWidth)

  await clock.advance(120)
  await terminal.redraw()
  await desktop.redraw()
  // the terminal steps its glyph; the desktop's spinner turns by itself, in a frame
  // that survives redraws only while its markup stays the same
  expect(await terminalCapsule()).not.toBe(first)
  const spinner = await desktop.find({ type: 'Svg' })
  expect(String(spinner?.props.source)).toBe(firstSvg)
  expect(spinner?.props.isInteractive).toBe(true)
  expect(firstSvg).toMatch(/<animateTransform attributeName="transform" type="rotate"/)
  await terminal.unmount()
  await desktop.unmount()
})

test('the pane button hides the band', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(240)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'toggle-band' })
  await pane.unmount()

  const band = await $.ui.mount({ ...WORKING_BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /thinking/ })).toBeUndefined()
  await band.unmount()
})

test('a completed turn plays the done sound', async ($, on) => {
  const { played } = engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(complete('t1'))
  await clock.settle()
  expect(played).toEqual(['assets/done.wav'])
})

test('sound: false keeps a completed turn quiet', { options: { sound: false } }, async ($, on) => {
  const { played } = engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(complete('t1'))
  await clock.settle()
  expect(played).toEqual([])
})

test('/panel opens the pane, and closes it once it is up', async ($, on) => {
  const placed: UiPane = { id: 'capsule-panel', title: 'Usage', isShown: true, isFocused: false, isPlaced: true }
  const { closed } = engine(on, [placed])
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: 'C:/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const run = () =>
    $.command.run({
      command: 'panel',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })
  expect((await run()).text).toMatch(/closed/)
  expect(closed).toEqual(['capsule-panel'])
})

test('/panel opens the pane while it is not up', async ($, on) => {
  const { closed } = engine(on, [])
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: 'C:/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const result = await $.command.run({
    command: 'panel',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(result.text).toMatch(/opened/)
  expect(closed).toEqual([])
})

test('a /clear resets the figures to placeholders', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.measure(measure(43))
  await clock.advance(1_000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /— \/ —/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^43%$/ })).toBeUndefined()
  await ui.unmount()
})
