import { atom, read, update } from 'claude-code'
import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  EngineInterface,
  PluginOptions,
  Register,
  RenderNode,
  SvgProps,
  TextProps,
  Timer,
} from 'claude-code'

import type {
  ActivityEntry,
  ActivityStatus,
  ContextBreakdown,
  Frame,
  GitInfo,
  Phase,
  RateSample,
  SessionTotals,
  TodoItem,
  TodoStatus,
  UsageSnapshot,
  WorkState,
} from '../types'

const PANE_ID = 'capsule-panel'
const PANE_TITLE = 'Usage'
const PANE_COLUMNS = 46
const TICK_MS = 120
const TWEEN_MS = 600
const HEARTBEAT_MS = 30_000
const GIT_DEBOUNCE_MS = 1_500
const MAX_ACTIVITY = 6
const SHOWN_ACTIVITY = 5
const MAX_RATES = 24
const MAX_SAMPLES = 60
const SAMPLE_EVERY_MS = 5 * 60_000
const BURN_WINDOW_MS = 30 * 60_000
const BURN_MIN_SPAN_MS = 5 * 60_000
const CHARS_PER_TOKEN = 3.5
const TOAST_MS = 8_000
const DONE_SOUND = 'assets/done.wav'
// tools that can change the work tree, and tools that start subagents (older builds name it Task)
const GIT_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit'])
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])
// what tool.call carries beside the tool's own arguments
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

// Catppuccin Mocha
const C = {
  base: '#1e1e2e',
  surface1: '#45475a',
  surface2: '#585b70',
  overlay0: '#6c7086',
  subtext: '#a6adc8',
  text: '#cdd6f4',
  lavender: '#b4befe',
  mauve: '#cba6f7',
  pink: '#f5c2e7',
  blue: '#89b4fa',
  sapphire: '#74c7ec',
  teal: '#94e2d5',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  peach: '#fab387',
  red: '#f38ba8',
} as const

// ── options ───────────────────────────────────────────────────────────────

type IconChoice = 'auto' | 'nerd' | 'unicode'
type Options = { icons: IconChoice; isSoundOn: boolean }

const parseOptions = (o: PluginOptions): Options => ({
  icons: o.icons === 'nerd' || o.icons === 'unicode' ? o.icons : 'auto',
  isSoundOn: o.sound !== false,
})

// ── icons ─────────────────────────────────────────────────────────────────

// Nerd Font glyphs, each checked against MartianMono Nerd Font's cmap.
const NERD = {
  capL: '\ue0b6',
  capR: '\ue0b4',
  sparkle: '\u{f0674}',
  context: '\u{f035b}',
  cache: '\uf1c0',
  tokens: '\uf0ec',
  cost: '\uf155',
  limits: '\uf017',
  reset: '\uf021',
  warn: '\uf071',
  activity: '\uf1da',
  speed: '\u{f04c5}',
  agent: '\u{f06a9}',
  branch: '\ue0a0',
  todo: '\uf0ae',
  dot: '\uf111',
  dotIdle: '\uf10c',
  legend: '\uf444',
  brain: '\u{f09d1}',
  pen: '\uf040',
  wrench: '\uf0ad',
} as const

type IconSet = { readonly [K in keyof typeof NERD]: string }

// Plain Unicode symbols nearly every font carries, with text presentation,
// for surfaces that draw with their own font (Claude Desktop) and terminals
// without a Nerd Font. No capsule caps: the pill is a plain colored block.
const UNICODE: IconSet = {
  capL: '',
  capR: '',
  sparkle: '✦',
  context: '◧',
  cache: '☰',
  tokens: '⇅',
  cost: '$',
  limits: '◷',
  reset: '↻',
  warn: '⚠',
  activity: '∿',
  speed: '»',
  agent: '◈',
  branch: '⎇',
  todo: '☑',
  dot: '●',
  dotIdle: '○',
  legend: '■',
  brain: '✻',
  pen: '✎',
  wrench: '⚒',
}

const PIE_NERD = ['\u{f0a9e}', '\u{f0a9f}', '\u{f0aa0}', '\u{f0aa1}', '\u{f0aa2}', '\u{f0aa3}', '\u{f0aa4}', '\u{f0aa5}']
const PIE_UNICODE = ['◐', '◓', '◑', '◒']

type Look = { icons: IconSet; pie: readonly string[]; isTerminal: boolean; hasSvg: boolean }

// the surfaces that draw an `Svg`; the terminal's table only stands one in
const SVG_SURFACES: ReadonlySet<string> = new Set(['desktop', 'vscode', 'mobile'])

/** Which glyphs a surface gets: Nerd Font in the terminal, plain symbols elsewhere, unless forced. */
const lookFor = (surface: string, choice: IconChoice): Look => {
  const isTerminal = surface === 'terminal'
  const isNerd = choice === 'nerd' || (choice === 'auto' && isTerminal)
  return {
    icons: isNerd ? NERD : UNICODE,
    pie: isNerd ? PIE_NERD : PIE_UNICODE,
    isTerminal,
    hasSvg: SVG_SURFACES.has(surface),
  }
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const LINE = '━'
const MARK = '┃'

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const mix = (a: string, b: string, t: number): string => {
  const [ar, ag, ab] = rgb(a)
  const [br, bg, bb] = rgb(b)
  const ch = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`
}

const SPARK_COLORS = SPARK.map((_, i) => mix(C.teal, C.mauve, i / (SPARK.length - 1)))
const BREATH = [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25].map(t => mix(C.teal, C.surface2, t))

const EMPTY_TOTALS: SessionTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
  lastInput: 0,
  lastRead: 0,
  lastWrite: 0,
}
const IDLE_WORK: WorkState = { isWorking: false, animUntil: 0 }
const IDLE_FRAME: Frame = { n: 0, at: 0, phase: 'idle' }

const snapshotAtom = atom({ plugin: 'capsule-panel', key: 'snapshot' } as const, null)
const totalsAtom = atom({ plugin: 'capsule-panel', key: 'totals' } as const, EMPTY_TOTALS)
const bandHiddenAtom = atom({ plugin: 'capsule-panel', key: 'isBandHidden' } as const, false)
const dismissedAtom = atom({ plugin: 'capsule-panel', key: 'isPaneDismissed' } as const, false)
const nowAtom = atom({ plugin: 'capsule-panel', key: 'now' } as const, 0)
const breakdownAtom = atom({ plugin: 'capsule-panel', key: 'breakdown' } as const, null)
const samplesAtom = atom({ plugin: 'capsule-panel', key: 'rateSamples' } as const, {})
const warningsAtom = atom({ plugin: 'capsule-panel', key: 'limitWarnings' } as const, {})
const activityAtom = atom({ plugin: 'capsule-panel', key: 'activity' } as const, [])
const streamAtom = atom({ plugin: 'capsule-panel', key: 'stream' } as const, { rates: [] })
const agentsAtom = atom({ plugin: 'capsule-panel', key: 'agents' } as const, { running: 0, names: [] })
const todosAtom = atom({ plugin: 'capsule-panel', key: 'todos' } as const, [])
const gitAtom = atom({ plugin: 'capsule-panel', key: 'git' } as const, null)
const workAtom = atom({ plugin: 'capsule-panel', key: 'work' } as const, IDLE_WORK)
const frameAtom = atom({ plugin: 'capsule-panel', key: 'frame' } as const, IDLE_FRAME)

// ── formatting ────────────────────────────────────────────────────────────

const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 100_000) return `${Math.round(n / 1_000)}k`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(n)}`
}

const fmtElapsed = (ms: number): string => {
  if (!(ms > 0)) return '—'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m`
  return `${total}s`
}

const fmtSeconds = (ms: number): string => {
  if (!(ms > 0)) return '0.0s'
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

const fmtSpan = (ms: number): string => {
  if (!(ms > 0)) return 'now'
  const mins = Math.round(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m`
}

const pctText = (pct: number | undefined): string => (pct === undefined ? '—' : `${Math.round(pct)}%`)

const clampPct = (pct: number | undefined): number => Math.max(0, Math.min(100, pct ?? 0))

const thresholdColor = (pct: number | undefined): string => {
  if (pct === undefined) return C.overlay0
  if (pct >= 80) return C.red
  if (pct >= 50) return C.yellow
  return C.green
}

const hitRate = (readTokens: number, writeTokens: number, inputTokens: number): number | undefined => {
  const total = readTokens + writeTokens + inputTokens
  return total > 0 ? Math.round((readTokens / total) * 100) : undefined
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g

/** Strips control characters (a tree holding one is refused) and cuts by code point. */
const clean = (text: string, max: number): string => {
  const flat = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

const toolName = (tool: string): string => {
  if (tool.startsWith('mcp__')) return clean(tool.split('__').pop() ?? tool, 7)
  return clean(tool, 7)
}

const summarize = (tool: string, args: Readonly<Record<string, unknown>>): string => {
  const str = (k: string): string | undefined => {
    const v = args[k]
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  const text = (() => {
    switch (tool) {
      case 'Bash':
      case 'PowerShell':
        return str('command') ?? str('description')
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'NotebookEdit': {
        const path = str('file_path') ?? str('notebook_path')
        return path === undefined ? undefined : basename(path)
      }
      case 'Grep':
      case 'Glob':
        return str('pattern')
      case 'Agent':
      case 'Task':
        return str('description') ?? str('subagent_type')
      case 'WebFetch': {
        const url = str('url')
        return url === undefined ? undefined : (/^\w+:\/\/([^/]+)/.exec(url)?.[1] ?? url)
      }
      case 'WebSearch':
        return str('query')
      case 'Skill':
        return str('skill')
      case 'TaskCreate':
        return str('subject')
      case 'TaskUpdate':
        return [str('taskId') === undefined ? '' : `#${str('taskId')}`, str('status') ?? ''].join(' ')
      case 'TodoWrite':
        return Array.isArray(args.todos) ? `${args.todos.length} items` : undefined
      default:
        return Object.entries(args).find(
          (kv): kv is [string, string] => !ENVELOPE_KEYS.has(kv[0]) && typeof kv[1] === 'string' && kv[1].length > 0,
        )?.[1]
    }
  })()
  return clean(text ?? '', 80)
}

const SHORT_KIND: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$' }
const shortKind = (kind: string): string => SHORT_KIND[kind] ?? kind.slice(0, 3)

const CATEGORY_LABELS: readonly [RegExp, string][] = [
  [/system prompt/i, 'sys'],
  [/system tools/i, 'tools'],
  [/mcp/i, 'mcp'],
  [/memory/i, 'memory'],
  [/agent/i, 'agents'],
  [/skill/i, 'skills'],
  [/slash|command/i, 'cmds'],
  [/message/i, 'msgs'],
]
const SLICE_COLORS: Record<string, string> = {
  sys: C.mauve,
  tools: C.blue,
  mcp: C.teal,
  memory: C.peach,
  agents: C.pink,
  skills: C.yellow,
  cmds: C.lavender,
  msgs: C.green,
}
const shortCategory = (name: string): string =>
  CATEGORY_LABELS.find(([re]) => re.test(name))?.[1] ?? clean(name.toLowerCase().split(' ')[0] ?? name, 8)
const sliceColor = (label: string): string => SLICE_COLORS[label] ?? C.sapphire

const ease = (t: number): number => 1 - (1 - t) ** 3

/** How far the count-up from the last measure has run, 0 to 1. */
const tweenProgress = (snapshot: UsageSnapshot | null, at: number): number => {
  if (snapshot?.prev === undefined || snapshot.changedAt === undefined) return 1
  return ease(Math.max(0, Math.min(1, (at - snapshot.changedAt) / TWEEN_MS)))
}

const tween = (from: number | undefined, to: number | undefined, t: number): number | undefined => {
  if (to === undefined) return undefined
  if (from === undefined || t >= 1) return to
  return from + (to - from) * t
}

// ── rate-limit burn ───────────────────────────────────────────────────────

type Burn = { etaMs: number; isShort: boolean }

const burnFor = (
  samples: readonly RateSample[] | undefined,
  pct: number,
  resetsAt: string | undefined,
  now: number,
): Burn | undefined => {
  const recent = (samples ?? []).filter(s => now - s.t <= BURN_WINDOW_MS)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (first === undefined || last === undefined || last.t - first.t < BURN_MIN_SPAN_MS) return undefined
  const slope = (last.pct - first.pct) / (last.t - first.t)
  if (!(slope > 0)) return undefined
  const etaMs = (100 - pct) / slope
  const resetMs = resetsAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(resetsAt) - now
  return { etaMs, isShort: etaMs < resetMs }
}

const addSamples = (
  prev: Readonly<Record<string, RateSample[]>>,
  limits: readonly { kind: string; percentUsed: number }[],
  now: number,
): Record<string, RateSample[]> => {
  const next: Record<string, RateSample[]> = { ...prev }
  for (const { kind, percentUsed } of limits) {
    let list = next[kind] ?? []
    const last = list[list.length - 1]
    // a drop means the window reset: start the slope over
    if (last !== undefined && percentUsed < last.pct - 0.5) list = []
    const tail = list[list.length - 1]
    if (tail === undefined || tail.pct !== percentUsed || now - tail.t >= SAMPLE_EVERY_MS) {
      list = [...list, { t: now, pct: percentUsed }].slice(-MAX_SAMPLES)
    }
    next[kind] = list
  }
  return next
}

// ── git ───────────────────────────────────────────────────────────────────

const parseGitStatus = (out: string): Omit<GitInfo, 'added' | 'removed'> => {
  let branch = ''
  let ahead = 0
  let behind = 0
  let files = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      ahead = Number(m?.[1] ?? '0')
      behind = Number(m?.[2] ?? '0')
    } else if (/^[12u?] /.test(line)) files += 1
  }
  return { branch: branch === '(detached)' ? 'detached' : branch, ahead, behind, files }
}

const parseShortstat = (out: string): { added: number; removed: number } => ({
  added: Number(/(\d+) insertion/.exec(out)?.[1] ?? '0'),
  removed: Number(/(\d+) deletion/.exec(out)?.[1] ?? '0'),
})

// ── todos ─────────────────────────────────────────────────────────────────

const isTodoStatus = (v: unknown): v is TodoStatus => v === 'pending' || v === 'in_progress' || v === 'completed'

const todosFromWrite = (raw: unknown): TodoItem[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  return raw.flatMap((item: unknown, i): TodoItem[] => {
    if (typeof item !== 'object' || item === null) return []
    const t = item as Record<string, unknown>
    if (typeof t.content !== 'string' || !isTodoStatus(t.status)) return []
    return [
      {
        id: String(i),
        subject: clean(t.content, 60),
        status: t.status,
        activeForm: typeof t.activeForm === 'string' ? clean(t.activeForm, 60) : undefined,
      },
    ]
  })
}

// ── module-local live state (a reload drops it, which costs one estimate) ──

let ticker: Timer | undefined
let gitTimer: Timer | undefined
let live: { chars: number; firstAt: number; phase: Phase } = { chars: 0, firstAt: 0, phase: 'idle' }

const tick = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  const work = await read($, workAtom)
  if (!work.isWorking && now > work.animUntil) {
    ticker?.cancel()
    ticker = undefined
    await update($, frameAtom, (f): Frame => ({ n: f.n, at: now, phase: 'idle' }))
    return
  }
  const span = now - live.firstAt
  const liveRate =
    work.isWorking && live.firstAt > 0 && span > 400 ? live.chars / CHARS_PER_TOKEN / (span / 1000) : undefined
  await update($, frameAtom, f => ({
    n: f.n + 1,
    at: now,
    phase: work.isWorking ? live.phase : 'idle',
    liveRate,
  }))
}

const ensureTicker = ($: EngineInterface): void => {
  if (ticker !== undefined) return
  ticker = $.clock.every(TICK_MS, () => {
    void tick($)
  })
}

const refreshGit = async ($: EngineInterface): Promise<void> => {
  try {
    const cwd = await $.session.cwd()
    const status = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], {
      cwd,
      timeoutMs: 5_000,
    })
    if (status.exitCode !== 0) {
      await update($, gitAtom, () => null)
      return
    }
    const info = parseGitStatus(status.stdout)
    const diff = await $.process.run(['git', '--no-optional-locks', 'diff', '--shortstat', 'HEAD'], {
      cwd,
      timeoutMs: 5_000,
    })
    const stat = diff.exitCode === 0 ? parseShortstat(diff.stdout) : { added: 0, removed: 0 }
    await update($, gitAtom, () => ({ ...info, ...stat }))
  } catch {
    // no git on PATH: the section stays hidden
  }
}

const scheduleGit = ($: EngineInterface): void => {
  gitTimer?.cancel()
  gitTimer = $.clock.after(GIT_DEBOUNCE_MS, () => {
    gitTimer = undefined
    void refreshGit($)
  })
}

const refreshAgents = async ($: EngineInterface): Promise<void> => {
  try {
    const list = await $.agent.list()
    const active = list.filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
    await update($, agentsAtom, () => ({
      running: active.length,
      names: active.slice(0, 3).map(a => clean(a.name ?? a.description ?? a.type, 16)),
    }))
  } catch {
    // keep the last count
  }
}

const refreshBreakdown = async ($: EngineInterface): Promise<void> => {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const b = usage.context.breakdown
    if (b === undefined) return
    const slices = b.categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(c => ({ label: shortCategory(c.name), tokens: c.tokens }))
    const next: ContextBreakdown = { slices, threshold: b.autoCompactThreshold }
    await update($, breakdownAtom, () => next)
  } catch {
    // the bar falls back to one colour
  }
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS })

/** Warns once per limit window when the burn forecast says it runs out before the reset. */
const warnOnBurn = async (
  $: EngineInterface,
  limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
  samples: Readonly<Record<string, RateSample[]>>,
  now: number,
): Promise<void> => {
  const warned = await read($, warningsAtom)
  for (const l of limits) {
    const burn = burnFor(samples[l.kind], l.percentUsed, l.resetsAt, now)
    const window = l.resetsAt ?? 'open'
    if (burn === undefined || !burn.isShort || warned[l.kind] === window) continue
    const resetIn = l.resetsAt === undefined ? undefined : Date.parse(l.resetsAt) - now
    const reset = resetIn === undefined || Number.isNaN(resetIn) ? '' : `, before it resets in ${fmtSpan(resetIn)}`
    $.ui.toast(`⚠ ${shortKind(l.kind)} limit on pace to run out in ~${fmtSpan(burn.etaMs)}${reset}`, {
      timeoutMs: TOAST_MS,
    })
    await update($, warningsAtom, w => ({ ...w, [l.kind]: window }))
  }
}

// ── drawing helpers ───────────────────────────────────────────────────────

type Ui = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Svg?: ElementConstructor<SvgProps>
}

type Cell = { ch: string; color: string }

const runs = (cells: readonly Cell[]): Cell[] => {
  const out: Cell[] = []
  for (const cell of cells) {
    const last = out[out.length - 1]
    if (last !== undefined && last.color === cell.color) last.ch += cell.ch
    else out.push({ ...cell })
  }
  return out
}

const drawCells = (ui: Ui, cells: readonly Cell[]) => (
  <ui.Text wrap="truncate-end">
    {runs(cells).map(r => (
      <ui.Text color={r.color}>{r.ch}</ui.Text>
    ))}
  </ui.Text>
)

// The capsule drawn as a picture where the surface's own font cannot draw its
// round ends: one line high, monospaced like the text around it, its icon a
// vector shape so every icon sits in the same box whatever fonts the surface has.
// Desktop sets plugin text at 13px on a 19px line: a 12px label in a 17px
// capsule reads as the same size without making the row taller.
const PILL_H = 17
const PILL_FONT = 12
const PILL_ADVANCE = PILL_FONT * 0.6
const PILL_PAD = 7
const ICON_BOX = 10
// the label's baseline, set by hand: Desktop's scrub drops dominant-baseline from a
// framed SVG, so 'central' would hold in an image and not in the spinner's frame
const PILL_BASELINE = PILL_H / 2 + 0.5 + PILL_FONT * 0.36
const ICON_GAP = 4
// the band's capsule keeps one width whatever it says, so nothing after it moves
const BAND_PILL_CHARS = 8

/** A capsule's icon: the glyph a text surface draws and the shape an SVG draws. */
type PillIcon = { glyph: string; shape: 'sparkle' | 'brain' | 'pen' | 'wrench' | 'spin' }

// One turn a second. The spinner turns inside its own SVG (SMIL), drawn in a
// frame Claude Desktop keeps across redraws while its markup stays the same:
// an image is rebuilt on every redraw, so swapping images never animated.
const SPIN_SECONDS = 1

const escapeXml = (text: string): string =>
  text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch] ?? ch)

/** The icon in a 10×10 box, drawn in `ink` over `bg`. */
const iconShape = (icon: PillIcon, ink: string, bg: string): string => {
  switch (icon.shape) {
    case 'sparkle':
      return `<path d="M5 0.5L6.1 3.9L9.5 5L6.1 6.1L5 9.5L3.9 6.1L0.5 5L3.9 3.9Z" fill="${ink}"/>`
    case 'brain':
      return `<path d="M5 1V9M1.5 3L8.5 7M1.5 7L8.5 3" stroke="${ink}" stroke-width="1.7" stroke-linecap="round"/>`
    case 'pen':
      return `<path d="M7.2 0.9L9.1 2.8L3.6 8.3L0.9 9.1L1.7 6.4Z" fill="${ink}"/>`
    case 'wrench':
      return (
        `<path d="M1.6 8.4L5.6 4.4" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>` +
        `<circle cx="6.8" cy="3.2" r="2.7" fill="${ink}"/><circle cx="8.3" cy="1.7" r="1.4" fill="${bg}"/>`
      )
    default:
      return (
        `<circle cx="5" cy="5" r="3.7" fill="none" stroke="${ink}" stroke-opacity="0.3" stroke-width="2.2"/>` +
        `<path d="M5 1.3A3.7 3.7 0 0 1 5 8.7" fill="none" stroke="${ink}" stroke-width="2.2" stroke-linecap="round">` +
        `<animateTransform attributeName="transform" type="rotate" from="0 5 5" to="360 5 5"` +
        ` dur="${SPIN_SECONDS}s" repeatCount="indefinite"/></path>`
      )
  }
}

/** The capsule's SVG and its width in CSS pixels; the label slot is at least `minChars` wide. */
const pillSvg = (icon: PillIcon, label: string, bg: string, minChars: number): { source: string; width: number } => {
  const chars = Array.from(label).length
  const textW = Math.round(chars * PILL_ADVANCE * 10) / 10
  const slotW = Math.max(chars, minChars) * PILL_ADVANCE
  const w = Math.ceil(2 * PILL_PAD + ICON_BOX + ICON_GAP + slotW)
  const h = PILL_H
  // icon and label centered together, whatever the label's length
  const groupW = chars === 0 ? ICON_BOX : ICON_BOX + ICON_GAP + textW
  const iconX = Math.round(((w - groupW) / 2) * 10) / 10
  const textX = iconX + ICON_BOX + ICON_GAP
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${bg}"/>` +
    `<g transform="translate(${iconX} ${(h - ICON_BOX) / 2})">${iconShape(icon, C.base, bg)}</g>` +
    (chars === 0
      ? ''
      : `<text x="${textX}" y="${Math.round(PILL_BASELINE * 10) / 10}"` +
        ` font-family="ui-monospace, 'Cascadia Mono', Consolas, Menlo, monospace" font-size="${PILL_FONT}" font-weight="600"` +
        ` fill="${C.base}" textLength="${textW}" lengthAdjust="spacingAndGlyphs">${escapeXml(label)}</text>`) +
    `</svg>`
  return { source, width: w }
}

/**
 * A capsule label: Nerd Font half-circle caps in the terminal, an SVG capsule
 * where the surface draws one (Claude Desktop), a plain colored block in a
 * terminal without the caps. `minChars` keeps the label slot that wide.
 */
const pill = (ui: Ui, look: Look, icon: PillIcon, label: string, bg: string, minChars = 0) => {
  const Svg = ui.Svg
  if (look.icons.capL === '' && look.hasSvg && Svg !== undefined) {
    const { source, width } = pillSvg(icon, label, bg, minChars)
    // never squeezed by a long line beside it; a spinner in a frame, so it turns
    return (
      <ui.Box flexShrink={0}>
        <Svg source={source} alt={label} width={width} height={PILL_H} isInteractive={icon.shape === 'spin'} />
      </ui.Box>
    )
  }
  const text = label.padEnd(minChars)
  if (look.icons.capL === '') {
    return (
      <ui.Text color={C.base} backgroundColor={bg} weight="semibold">
        {` ${icon.glyph} ${text} `}
      </ui.Text>
    )
  }
  return (
    <ui.Text>
      <ui.Text color={bg}>{look.icons.capL}</ui.Text>
      <ui.Text color={C.base} backgroundColor={bg} weight="semibold">
        {`${icon.glyph} ${text}`}
      </ui.Text>
      <ui.Text color={bg}>{look.icons.capR}</ui.Text>
    </ui.Text>
  )
}

const sectionHeader = (ui: Ui, icon: string, label: string, accent: string, right?: RenderNode) => (
  <ui.Box flexDirection="row" justifyContent="space-between">
    <ui.Text color={accent} weight="semibold">
      {`${icon} ${label}`}
    </ui.Text>
    {right ?? <ui.Text> </ui.Text>}
  </ui.Box>
)

const metricRow = (ui: Ui, icon: string, label: string, accent: string, body: RenderNode[]) => (
  <ui.Box flexDirection="row">
    <ui.Text color={accent}>{`${icon} `}</ui.Text>
    <ui.Text color={C.subtext} weight="semibold">
      {label.padEnd(7)}
    </ui.Text>
    <ui.Text wrap="truncate-end">{body}</ui.Text>
  </ui.Box>
)

const gap = (ui: Ui) => <ui.Text> </ui.Text>

const barCells = (width: number, pct: number | undefined, color: string): Cell[] => {
  const filled = Math.round((width * clampPct(pct)) / 100)
  return [
    ...Array.from({ length: filled }, () => ({ ch: LINE, color })),
    ...Array.from({ length: width - filled }, () => ({ ch: LINE, color: C.surface1 })),
  ]
}

const contextCells = (
  width: number,
  pct: number | undefined,
  breakdown: ContextBreakdown | null,
  windowTokens: number,
  shimmer: number | undefined,
): Cell[] => {
  const filled = Math.round((width * clampPct(pct)) / 100)
  const cells: Cell[] = []
  const slices = breakdown?.slices ?? []
  const total = slices.reduce((s, x) => s + x.tokens, 0)
  if (slices.length > 0 && total > 0) {
    // largest remainder, so the slices add up to the filled cells exactly
    const exact = slices.map(s => (filled * s.tokens) / total)
    const alloc = exact.map(Math.floor)
    let rest = filled - alloc.reduce((s, x) => s + x, 0)
    const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
    for (const [, i] of order) {
      if (rest <= 0) break
      alloc[i] = (alloc[i] ?? 0) + 1
      rest -= 1
    }
    slices.forEach((s, i) => {
      for (let k = 0; k < (alloc[i] ?? 0); k++) cells.push({ ch: LINE, color: sliceColor(s.label) })
    })
  } else {
    for (let k = 0; k < filled; k++) cells.push({ ch: LINE, color: thresholdColor(pct) })
  }
  while (cells.length < width) cells.push({ ch: LINE, color: C.surface1 })

  if (shimmer !== undefined && filled > 2) {
    const at = shimmer % (filled + 8)
    const head = cells[at]
    if (at < filled && head !== undefined) head.color = C.text
    const trail = cells[at - 1]
    if (at - 1 >= 0 && at - 1 < filled && trail !== undefined) trail.color = C.lavender
  }

  const threshold = breakdown?.threshold
  if (threshold !== undefined && windowTokens > 0 && threshold < windowTokens) {
    const at = Math.min(width - 1, Math.round((width * threshold) / windowTokens))
    cells[at] = { ch: MARK, color: C.yellow }
  }
  return cells
}

const sparkCells = (rates: readonly number[], width: number): Cell[] => {
  const shown = rates.slice(-width)
  const max = Math.max(1, ...shown)
  return shown.map(r => {
    const level = Math.max(0, Math.min(SPARK.length - 1, Math.round((r / max) * (SPARK.length - 1))))
    return { ch: SPARK[level] ?? '▁', color: SPARK_COLORS[level] ?? C.teal }
  })
}

const statusGlyph = (status: ActivityStatus, n: number, pie: readonly string[]): Cell => {
  if (status === 'running') return { ch: pie[n % pie.length] ?? '•', color: C.peach }
  if (status === 'error') return { ch: '✗', color: C.red }
  return { ch: '✓', color: C.green }
}

/**
 * What the band's capsule says for a phase. Waiting on tools, or between
 * steps, it spins; `spin` is that step's spinner.
 */
const phaseLook = (phase: Phase, icons: IconSet, spin: PillIcon): { icon: PillIcon; label: string; color: string } => {
  switch (phase) {
    case 'thinking':
      return { icon: { glyph: icons.brain, shape: 'brain' }, label: 'thinking', color: C.mauve }
    case 'responding':
      return { icon: { glyph: icons.pen, shape: 'pen' }, label: 'writing', color: C.blue }
    case 'tool-input':
      return { icon: { glyph: icons.wrench, shape: 'wrench' }, label: 'tool use', color: C.peach }
    default:
      return { icon: spin, label: 'working', color: C.teal }
  }
}

// ── hooks ─────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const opts = parseOptions(options)

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'panel', description: 'Toggle the usage panel', immediate: true })
    } catch (error) {
      $.ui.toast(`capsule-panel: /panel failed to register ${String(error)}`)
    }

    void (async () => {
      try {
        const usage = await $.session.usage()
        const model = await $.session.model()
        const now = await $.clock.now()
        await update($, snapshotAtom, old => ({
          context: { tokens: usage.context.tokens, window: usage.context.window, percent: usage.context.percent },
          rateLimits: usage.rateLimits.map(l => ({ ...l })),
          costUsd: usage.cost?.usd,
          startedAt: usage.startedAt,
          prev: old?.prev,
          changedAt: old?.changedAt,
        }))
        await update($, totalsAtom, prev => ({ ...prev, model: prev.model ?? model }))
        await update($, nowAtom, () => now)
      } catch {
        // placeholders stay until session.measure fills them
      }
      await refreshAgents($)
      await refreshGit($)
      await refreshBreakdown($)
    })()

    void (async () => {
      if (!(await read($, dismissedAtom))) await openPane($)
      if ((await read($, workAtom)).isWorking) ensureTicker($)
    })()

    $.clock.every(HEARTBEAT_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        await update($, nowAtom, () => now)
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'panel' }, async $ => {
    const pane = (await $.ui.panes()).find(p => p.id === PANE_ID)
    if (pane?.isPlaced === true) {
      await update($, dismissedAtom, () => true)
      await $.ui.close({ id: PANE_ID })
      return { text: 'Usage panel closed' }
    }
    await update($, dismissedAtom, () => false)
    void openPane($)
    return { text: 'Usage panel opened' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID && e.origin.kind === 'person') await update($, dismissedAtom, () => true)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    const prev = await read($, snapshotAtom)
    await update($, snapshotAtom, () => ({
      context: { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent },
      rateLimits: e.rateLimits.map(l => ({ ...l })),
      costUsd: e.cost?.usd,
      startedAt: prev?.startedAt,
      prev:
        prev === null
          ? undefined
          : { tokens: prev.context.tokens, percent: prev.context.percent, costUsd: prev.costUsd },
      changedAt: now,
    }))
    if (e.rateLimits.length > 0) {
      const samples = await update($, samplesAtom, s => addSamples(s, e.rateLimits, now))
      await warnOnBurn($, e.rateLimits, samples, now)
    }
    await update($, workAtom, w => ({ ...w, animUntil: Math.max(w.animUntil, now + TWEEN_MS + 2 * TICK_MS) }))
    ensureTicker($)

    if (e.changed.includes('context')) void refreshBreakdown($)
    if (prev?.startedAt === undefined) {
      void (async () => {
        try {
          const { startedAt } = await $.session.usage()
          await update($, snapshotAtom, old => (old === null ? old : { ...old, startedAt }))
        } catch {
          // keep the placeholder
        }
      })()
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    live = { chars: 0, firstAt: 0, phase: 'thinking' }
    await update($, workAtom, w => ({ ...w, isWorking: true, startedAt: now }))
    ensureTicker($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (e.agentId !== undefined) return yield* stream

    let firstAt = 0
    for await (const chunk of stream) {
      if (chunk.kind === 'text' || chunk.kind === 'thinking' || chunk.kind === 'input') {
        if (firstAt === 0) {
          firstAt = await $.clock.now()
          live.firstAt = firstAt
          live.chars = 0
        }
        live.chars += chunk.kind === 'input' ? chunk.json.length : chunk.text.length
        live.phase = chunk.kind === 'text' ? 'responding' : chunk.kind === 'thinking' ? 'thinking' : 'tool-input'
      } else if (chunk.kind === 'tool') {
        live.phase = 'tool-input'
      } else if (chunk.kind === 'stop') {
        const out = chunk.usage?.output_tokens
        if (out !== undefined && firstAt > 0) {
          const secs = ((await $.clock.now()) - firstAt) / 1000
          if (out >= 16 && secs >= 0.3) {
            const rate = out / secs
            await update($, streamAtom, s => ({ rates: [...s.rates, rate].slice(-MAX_RATES) }))
          }
        }
      }
      yield chunk
    }
    live.firstAt = 0
    live.phase = 'tools'
    return await stream.result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const args = e as unknown as Readonly<Record<string, unknown>>
    const startedAt = await $.clock.now()
    const id = e.tool_use_id ?? `${e.tool}-${startedAt}`
    const entry: ActivityEntry = {
      id,
      tool: e.tool,
      summary: summarize(e.tool, args),
      startedAt,
      status: 'running',
    }
    await update($, activityAtom, list => [...list.filter(x => x.id !== id), entry].slice(-MAX_ACTIVITY))

    const finish = async (status: ActivityStatus) => {
      const endedAt = await $.clock.now()
      await update($, activityAtom, list =>
        list.map(x => (x.id === id ? { ...x, status, durationMs: endedAt - startedAt } : x)),
      )
    }

    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (error) {
      await finish('error')
      throw error
    }
    const hasFailed = ran.deny !== undefined || ran.isError === true
    await finish(hasFailed ? 'error' : 'ok')

    if (!hasFailed) {
      if (e.tool === 'TodoWrite') {
        const todos = todosFromWrite(args.todos)
        if (todos !== undefined) await update($, todosAtom, () => todos)
      } else if (e.tool === 'TaskCreate') {
        const created = (ran.result as { task?: { id?: unknown } } | undefined)?.task?.id
        const subject = typeof args.subject === 'string' ? clean(args.subject, 60) : 'task'
        const activeForm = typeof args.activeForm === 'string' ? clean(args.activeForm, 60) : undefined
        if (typeof created === 'string' || typeof created === 'number') {
          const item: TodoItem = { id: String(created), subject, status: 'pending', activeForm }
          await update($, todosAtom, list => [...list.filter(t => t.id !== item.id), item])
        }
      } else if (e.tool === 'TaskUpdate') {
        const taskId = String(args.taskId ?? '')
        const status = args.status
        await update($, todosAtom, list =>
          status === 'deleted'
            ? list.filter(t => t.id !== taskId)
            : list.map(t =>
                t.id !== taskId
                  ? t
                  : {
                      ...t,
                      status: isTodoStatus(status) ? status : t.status,
                      subject: typeof args.subject === 'string' ? clean(args.subject, 60) : t.subject,
                      activeForm: typeof args.activeForm === 'string' ? clean(args.activeForm, 60) : t.activeForm,
                    },
              ),
        )
      }
    }
    if (GIT_TOOLS.has(e.tool)) scheduleGit($)
    if (AGENT_TOOLS.has(e.tool)) void refreshAgents($)

    return ran
  })

  on('classic.SubagentStart', async ($, e, next) => {
    const result = await next(e)
    void refreshAgents($)
    return result
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    void refreshAgents($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      void refreshAgents($)
      return next(e)
    }

    const usage = e.usage
    if (usage !== undefined) {
      await update($, totalsAtom, prev => ({
        input: prev.input + usage.input_tokens,
        output: prev.output + usage.output_tokens,
        cacheRead: prev.cacheRead + usage.cache_read_input_tokens,
        cacheWrite: prev.cacheWrite + usage.cache_creation_input_tokens,
        turns: prev.turns + 1,
        lastInput: usage.input_tokens,
        lastRead: usage.cache_read_input_tokens,
        lastWrite: usage.cache_creation_input_tokens,
        model: usage.model,
      }))
    }

    const now = await $.clock.now()
    live = { chars: 0, firstAt: 0, phase: 'idle' }
    await update($, workAtom, w => ({ ...w, isWorking: false, animUntil: Math.max(w.animUntil, now + TWEEN_MS) }))
    // a call cut off by an interrupt never reports back
    await update($, activityAtom, list =>
      list.map(x => (x.status === 'running' ? { ...x, status: 'error', durationMs: now - x.startedAt } : x)),
    )
    scheduleGit($)
    void refreshAgents($)

    // a Windows terminal has no player and plays nothing; elsewhere a short tone
    if (opts.isSoundOn && !e.isAborted) {
      void $.audio.play({ asset: DONE_SOUND }, { gain: 0.6 }).catch(() => undefined)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') return next(e)

    await update($, totalsAtom, () => ({ ...EMPTY_TOTALS }))
    await update($, snapshotAtom, () => null)
    await update($, breakdownAtom, () => null)
    await update($, activityAtom, () => [])
    await update($, streamAtom, () => ({ rates: [] }))
    await update($, todosAtom, () => [])
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const ui: Ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const look = lookFor(e.surface, opts.icons)
    const { icons } = look
    const [snapshot, totals, breakdown, samples, activity, stream, agents, todos, git, work, frame, bandHidden, now] =
      await Promise.all([
        read($, snapshotAtom),
        read($, totalsAtom),
        read($, breakdownAtom),
        read($, samplesAtom),
        read($, activityAtom),
        read($, streamAtom),
        read($, agentsAtom),
        read($, todosAtom),
        read($, gitAtom),
        read($, workAtom),
        read($, frameAtom),
        read($, bandHiddenAtom),
        read($, nowAtom),
      ])

    const W = Math.max(28, e.props.bodyColumns - 2)
    const clock = Math.max(now, frame.at)
    const isWorking = work.isWorking
    const t = tweenProgress(snapshot, frame.at)

    // header
    const startedAt = snapshot?.startedAt
    const elapsed = startedAt === undefined ? '—' : fmtElapsed(clock - startedAt)
    const liveColor = isWorking ? (BREATH[frame.n % BREATH.length] ?? C.teal) : C.overlay0

    // context
    const ctx = snapshot?.context
    const pct = ctx?.percent
    const pctShown = tween(snapshot?.prev?.percent, pct, t)
    const tokShown = tween(snapshot?.prev?.tokens, ctx?.tokens, t)
    const legend = [...(breakdown?.slices ?? [])].sort((a, b) => b.tokens - a.tokens).slice(0, 4)

    // usage
    const hit = hitRate(totals.cacheRead, totals.cacheWrite, totals.input)
    const hitColor = hit === undefined ? C.overlay0 : hit >= 70 ? C.green : hit >= 40 ? C.yellow : C.peach
    const costShown = tween(snapshot?.prev?.costUsd, snapshot?.costUsd, t)
    const hours = startedAt === undefined ? 0 : (clock - startedAt) / 3_600_000
    const limits = snapshot?.rateLimits ?? []
    const perHour = hours >= 1 / 30 && snapshot?.costUsd !== undefined ? snapshot.costUsd / hours : undefined
    const tokTotal = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
    const tokPerHour = hours >= 1 / 30 ? tokTotal / hours : undefined

    // activity
    const lastRate = stream.rates[stream.rates.length - 1]
    const shownRate = isWorking && frame.liveRate !== undefined ? frame.liveRate : lastRate
    const recent = activity.slice(-SHOWN_ACTIVITY).reverse()

    // todos
    const done = todos.filter(x => x.status === 'completed').length
    const current = todos.find(x => x.status === 'in_progress')

    const limitBarW = Math.max(6, W - 27)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          {pill(ui, look, { glyph: icons.sparkle, shape: 'sparkle' }, 'USAGE', C.mauve)}
          <Text>
            <Text color={liveColor}>{isWorking ? icons.dot : icons.dotIdle}</Text>
            <Text color={isWorking ? C.teal : C.overlay0}>{isWorking ? ' live' : ' idle'}</Text>
            <Text color={C.overlay0} tabular>{`  ${elapsed}`}</Text>
          </Text>
        </Box>
        {gap(ui)}

        {sectionHeader(
          ui,
          icons.context,
          'CONTEXT',
          thresholdColor(pct),
          <Text tabular>
            <Text color={C.subtext}>
              {ctx === undefined
                ? '— / — '
                : `${tokShown === undefined ? '—' : fmtTokens(tokShown)} / ${fmtTokens(ctx.window)} `}
            </Text>
            <Text color={thresholdColor(pct)} weight="semibold">
              {pctText(pctShown)}
            </Text>
          </Text>,
        )}
        {drawCells(ui, contextCells(W, pctShown, breakdown, ctx?.window ?? 0, isWorking ? frame.n : undefined))}
        {legend.length > 0 && (
          <Text wrap="truncate-end" size="footnote">
            {legend.map(s => (
              <Text>
                <Text color={sliceColor(s.label)}>{icons.legend}</Text>
                <Text color={C.overlay0}>{` ${s.label} ${fmtTokens(s.tokens)}  `}</Text>
              </Text>
            ))}
          </Text>
        )}
        {gap(ui)}

        {metricRow(ui, icons.cache, 'CACHE', C.teal, [
          <Text color={hitColor} weight="semibold" tabular>
            {hit === undefined ? '—' : `${hit}% hit`}
          </Text>,
          <Text color={C.overlay0} tabular>{`  R ${fmtTokens(totals.cacheRead)}  W ${fmtTokens(totals.cacheWrite)}`}</Text>,
        ])}
        {metricRow(ui, icons.tokens, 'TOKENS', C.blue, [
          <Text color={C.text} tabular>{`↑ ${fmtTokens(totals.input)}  ↓ ${fmtTokens(totals.output)}`}</Text>,
          <Text color={C.overlay0} tabular>{`  ${totals.turns} turn${totals.turns === 1 ? '' : 's'}`}</Text>,
        ])}
        {metricRow(ui, icons.cost, 'COST', C.peach, [
          <Text color={C.peach} weight="semibold" tabular>
            {costShown === undefined ? '—' : `$${costShown.toFixed(2)}`}
          </Text>,
          <Text color={C.overlay0} tabular>
            {[
              perHour === undefined ? '' : `  $${perHour.toFixed(2)}/h`,
              limits.length === 0 && tokPerHour !== undefined ? `  ${fmtTokens(tokPerHour)} tok/h` : '',
            ].join('')}
          </Text>,
        ])}

        {limits.length > 0 && gap(ui)}
        {limits.length > 0 && sectionHeader(ui, icons.limits, 'LIMITS', C.sapphire)}
        {limits.map(l => {
          const burn = burnFor(samples[l.kind], l.percentUsed, l.resetsAt, clock)
          const resetIn = l.resetsAt === undefined ? undefined : Date.parse(l.resetsAt) - clock
          return (
            <Box flexDirection="row">
              <Text color={C.subtext}>{shortKind(l.kind).padEnd(3)}</Text>
              {drawCells(ui, barCells(limitBarW, l.percentUsed, thresholdColor(l.percentUsed)))}
              <Text color={thresholdColor(l.percentUsed)} weight="semibold" tabular>{` ${pctText(l.percentUsed).padStart(4)}`}</Text>
              <Text color={C.overlay0} tabular>
                {resetIn === undefined || Number.isNaN(resetIn) ? '' : `  ${icons.reset} ${fmtSpan(resetIn)}`}
              </Text>
              {burn !== undefined &&
                (burn.isShort ? (
                  <Text color={C.red} tabular>{`  ${icons.warn} ~${fmtSpan(burn.etaMs)}`}</Text>
                ) : (
                  <Text color={C.green}>{'  ✓'}</Text>
                ))}
            </Box>
          )
        })}
        {gap(ui)}

        {sectionHeader(
          ui,
          icons.activity,
          'ACTIVITY',
          C.lavender,
          shownRate === undefined ? undefined : (
            <Text color={isWorking ? C.teal : C.overlay0} tabular>{`${icons.speed} ${Math.round(shownRate)} tok/s`}</Text>
          ),
        )}
        {stream.rates.length >= 2 && drawCells(ui, sparkCells(stream.rates, W))}
        {recent.map(a => {
          const glyph = statusGlyph(a.status, frame.n, look.pie)
          const ms = a.status === 'running' ? clock - a.startedAt : (a.durationMs ?? 0)
          return (
            <Box flexDirection="row">
              <Text color={glyph.color}>{`${glyph.ch} `}</Text>
              <Text color={C.blue} weight={a.status === 'running' ? 'semibold' : 'regular'}>
                {toolName(a.tool).padEnd(8)}
              </Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text color={C.subtext} wrap="truncate-end">
                  {a.summary}
                </Text>
              </Box>
              <Text color={C.overlay0} tabular>{` ${fmtSeconds(ms)}`}</Text>
            </Box>
          )
        })}
        {agents.running > 0 && (
          <Text color={C.pink} wrap="truncate-end">
            {`${icons.agent} ${agents.running} agent${agents.running === 1 ? '' : 's'} running`}
            {agents.names.length > 0 && <Text color={C.overlay0}>{` · ${agents.names.join(', ')}`}</Text>}
          </Text>
        )}
        {recent.length === 0 && stream.rates.length < 2 && agents.running === 0 && (
          <Text color={C.overlay0}>no activity yet</Text>
        )}

        {(git !== null || todos.length > 0) && gap(ui)}
        {git !== null && (
          <Text wrap="truncate-end" size="footnote">
            <Text color={C.green}>{`${icons.branch} `}</Text>
            <Text color={C.green} weight="semibold">
              {clean(git.branch, 24)}
            </Text>
            <Text color={C.overlay0}>{git.ahead + git.behind > 0 ? ` ↑${git.ahead} ↓${git.behind}` : ''}</Text>
            {git.added + git.removed > 0 && <Text color={C.green}>{`  +${git.added}`}</Text>}
            {git.added + git.removed > 0 && <Text color={C.red}>{` −${git.removed}`}</Text>}
            <Text color={C.overlay0}>{git.files > 0 ? ` · ${git.files} files` : ' · clean'}</Text>
          </Text>
        )}
        {todos.length > 0 && (
          <Box flexDirection="row">
            <Text color={C.lavender} weight="semibold">{`${icons.todo} TODO `}</Text>
            {drawCells(ui, barCells(12, (done / todos.length) * 100, C.lavender))}
            <Text color={C.text} tabular>{` ${done}/${todos.length}`}</Text>
          </Box>
        )}
        {current !== undefined && (
          <Text color={C.subtext} wrap="truncate-end" size="footnote">
            {`  → ${current.activeForm ?? current.subject}`}
          </Text>
        )}

        {gap(ui)}
        <Button
          key="toggle-band"
          plain
          dimColor
          label={bandHidden ? 'show activity band' : 'hide activity band'}
          onPress={() => update($, bandHiddenAtom, v => !v)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!e.props.isWorking || e.props.hasSurvey) return next(e)
    if (await read($, bandHiddenAtom)) return next(e)

    const ui: Ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const look = lookFor(e.surface, opts.icons)
    const { icons } = look
    const [activity, frame, work, stream, agents] = await Promise.all([
      read($, activityAtom),
      read($, frameAtom),
      read($, workAtom),
      read($, streamAtom),
      read($, agentsAtom),
    ])

    const running = [...activity].reverse().find(a => a.status === 'running')
    const spin: PillIcon = { glyph: look.pie[frame.n % look.pie.length] ?? '•', shape: 'spin' }
    const current =
      running === undefined
        ? phaseLook(frame.phase, icons, spin)
        : { icon: spin, label: toolName(running.tool), color: C.peach }
    const detail = running === undefined ? '' : ` ${running.summary}`
    const toolMs = running === undefined ? undefined : frame.at - running.startedAt
    const turnMs = work.startedAt === undefined ? undefined : frame.at - work.startedAt
    const rate = frame.liveRate ?? stream.rates[stream.rates.length - 1]

    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" width={e.props.bodyColumns}>
        <Box flexDirection="row" flexShrink={1} minWidth={0} alignItems="center">
          {pill(ui, look, current.icon, current.label, current.color, BAND_PILL_CHARS)}
          <Text color={C.subtext} wrap="truncate-end" tabular>
            {`${detail}${toolMs === undefined ? '' : ` · ${fmtSeconds(toolMs)}`}`}
          </Text>
        </Box>
        <Text tabular>
          {rate !== undefined && <Text color={C.teal}>{`  ${icons.speed} ${Math.round(rate)} tok/s`}</Text>}
          {agents.running > 0 && <Text color={C.pink}>{`  ${icons.agent} ${agents.running}`}</Text>}
          {turnMs !== undefined && <Text color={C.overlay0}>{`  ${fmtElapsed(turnMs)}`}</Text>}
        </Text>
      </Box>
    )
  })
}
