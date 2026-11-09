import { atom, read, update } from 'claude-code'
import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  EngineInterface,
  Register,
  RenderNode,
  SvgProps,
  TextProps,
  Timer,
  TurnUsage,
} from 'claude-code'

import type {
  ActivityEntry,
  ActivityStatus,
  CacheClock,
  ChangedFile,
  ContextBreakdown,
  FileStat,
  Frame,
  GitInfo,
  Phase,
  RateSample,
  SessionTotals,
  PanelSettings,
  SpendState,
  SpendTotals,
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
const NOTIFY_STEPS = [30, 60, 120, 300] as const
const TTL_5M = 5 * 60_000
const TTL_1H = 60 * 60_000
const CACHE_LAST_MINUTE_MS = 60_000
const SPEND_PREFIX = 'spend/'
const SPEND_KEEP_DAYS = 14
const SPEND_REFRESH_MS = 5 * 60_000
const TOTALS_PREFIX = 'totals/'
const TOTALS_SAVE_MS = 5_000
const TOTALS_KEEP_DAYS = 30
const DAY_MS = 24 * 60 * 60_000
const CTX_HISTORY = 6
const COMPACT_ARM_MS = 3_000
const COMPACT_SHOWN_MS = 15 * 60_000
const MAX_FILES = 50
const SHOWN_FILES = 5
const FLASH_MS = 1_000
const HOT_PCT = 80
// tools that can change the work tree, tools that write a file, and tools that
// start subagents (older builds name it Task)
const GIT_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit'])
const FILE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit'])
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

// ── settings ──────────────────────────────────────────────────────────────

// Kept in the plugin's own store, not settings.json (which a provider switcher
// may rewrite, and which Claude Desktop has no menu for), one set per surface.
type SurfaceKey = 'terminal' | 'desktop'

const surfaceKey = (surface: string): SurfaceKey => (surface === 'terminal' ? 'terminal' : 'desktop')

const TERMINAL_DEFAULTS: PanelSettings = {
  band: true,
  sound: true,
  notify: true,
  notifyAfterS: 60,
  git: true,
  cacheTimer: true,
  cacheTtl: 'auto',
  spend: true,
  compactForecast: true,
  versions: true,
  icons: 'nerd',
}

// Claude Desktop notifies and chimes on its own
const DESKTOP_DEFAULTS: PanelSettings = { ...TERMINAL_DEFAULTS, sound: false, notify: false }

const defaultsFor = (key: SurfaceKey): PanelSettings => (key === 'terminal' ? TERMINAL_DEFAULTS : DESKTOP_DEFAULTS)

/** A stored value read over the defaults, field by field, so an old or partial one is safe. */
const normalizeSettings = (raw: unknown, key: SurfaceKey): PanelSettings => {
  const base = defaultsFor(key)
  if (typeof raw !== 'object' || raw === null) return base
  const r = raw as Record<string, unknown>
  const bool = (k: keyof PanelSettings): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (base[k] as boolean))
  return {
    band: bool('band'),
    sound: bool('sound'),
    notify: bool('notify'),
    notifyAfterS: NOTIFY_STEPS.find(s => s === r.notifyAfterS) ?? base.notifyAfterS,
    git: bool('git'),
    cacheTimer: bool('cacheTimer'),
    cacheTtl: r.cacheTtl === '5m' || r.cacheTtl === '1h' || r.cacheTtl === 'auto' ? r.cacheTtl : base.cacheTtl,
    spend: bool('spend'),
    compactForecast: bool('compactForecast'),
    versions: bool('versions'),
    icons: r.icons === 'unicode' || r.icons === 'nerd' ? r.icons : base.icons,
  }
}

const settingsFor = (all: Readonly<Record<string, PanelSettings>>, surface: string): PanelSettings => {
  const key = surfaceKey(surface)
  return all[key] ?? defaultsFor(key)
}

type IconChoice = 'auto' | 'nerd' | 'unicode'

/** The icon set a surface draws with: the terminal's setting there, vector shapes elsewhere. */
const iconChoice = (surface: string, settings: PanelSettings): IconChoice =>
  surface === 'terminal' ? settings.icons : 'auto'

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
  timer: '\uf252',
  gear: '\uf013',
  spend: '\uf073',
  files: '\uf0f6',
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
  timer: '⧗',
  gear: '⚙',
  spend: '▦',
  files: '▤',
}

const PIE_NERD = ['\u{f0a9e}', '\u{f0a9f}', '\u{f0aa0}', '\u{f0aa1}', '\u{f0aa2}', '\u{f0aa3}', '\u{f0aa4}', '\u{f0aa5}']
const PIE_UNICODE = ['◐', '◓', '◑', '◒']

/** `isVector`: icons and capsules are drawn as SVG shapes rather than font glyphs. */
type Look = { icons: IconSet; pie: readonly string[]; isTerminal: boolean; isVector: boolean }

// the surfaces that draw an `Svg`; the terminal's table only stands one in
const SVG_SURFACES: ReadonlySet<string> = new Set(['desktop', 'vscode', 'mobile'])

/** Which glyphs a surface gets: Nerd Font in the terminal, vector shapes elsewhere, unless forced. */
const lookFor = (surface: string, choice: IconChoice): Look => {
  const isTerminal = surface === 'terminal'
  const isNerd = choice === 'nerd' || (choice === 'auto' && isTerminal)
  return {
    icons: isNerd ? NERD : UNICODE,
    pie: isNerd ? PIE_NERD : PIE_UNICODE,
    isTerminal,
    isVector: !isNerd && SVG_SURFACES.has(surface),
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
// a figure at or past HOT_PCT pulses while Claude works
const RED_BREATH = [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25].map(t => mix(C.red, C.surface2, t * 0.6))

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
const NO_SPEND: SpendTotals = { today: 0, week: 0, days: [0, 0, 0, 0, 0, 0, 0] }
const FRESH_SPEND: SpendState = { owner: '', day: '', base: 0, lastUsd: 0, others: NO_SPEND }
const FRESH_CACHE: CacheClock = { autoTtlMs: TTL_5M }

const snapshotAtom = atom({ plugin: 'capsule-panel', key: 'snapshot' } as const, null)
const totalsAtom = atom({ plugin: 'capsule-panel', key: 'totals' } as const, EMPTY_TOTALS)
const settingsAtom = atom({ plugin: 'capsule-panel', key: 'settings' } as const, {})
const paneViewAtom = atom({ plugin: 'capsule-panel', key: 'paneView' } as const, 'dash')
const modelInfoAtom = atom({ plugin: 'capsule-panel', key: 'modelInfo' } as const, {})
const versionsAtom = atom({ plugin: 'capsule-panel', key: 'versions' } as const, {})
const cacheAtom = atom({ plugin: 'capsule-panel', key: 'cacheClock' } as const, FRESH_CACHE)
const spendAtom = atom({ plugin: 'capsule-panel', key: 'spend' } as const, FRESH_SPEND)
const ctxHistoryAtom = atom({ plugin: 'capsule-panel', key: 'ctxHistory' } as const, [])
const lastCompactAtom = atom({ plugin: 'capsule-panel', key: 'lastCompact' } as const, null)
const compactArmedAtom = atom({ plugin: 'capsule-panel', key: 'compactArmedUntil' } as const, 0)
const filesAtom = atom({ plugin: 'capsule-panel', key: 'files' } as const, [])
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

/** `claude-opus-5-5[1M]` → `opus-5.5`; `claude-haiku-4-5-20251001` → `haiku-4.5`. */
const shortModel = (model: string): string =>
  clean(
    model
      .replace(/^claude-/, '')
      .replace(/\[.*\]$/, '')
      .replace(/-\d{8}$/, '')
      .replace(/-(\d+)-(\d+)$/, '-$1.$2'),
    18,
  )

const effortText = (effort: string | number | undefined): string | undefined =>
  effort === undefined ? undefined : typeof effort === 'number' ? `effort ${effort}` : effort

const fmtUsd = (usd: number): string => (usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`)

/** The last minute of a countdown, `0:42`. */
const fmtClock = (ms: number): string => `0:${String(Math.max(0, Math.ceil(ms / 1000))).padStart(2, '0')}`

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** The local calendar day of a time, `2026-11-09`; such strings sort as dates. */
const localDay = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** The local day `n` days before the day of `ms`. */
const dayBefore = (ms: number, n: number): string => {
  const d = new Date(ms)
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, 12).getTime())
}

/** The Monday that starts the week of `ms`. */
const weekStart = (ms: number): string => dayBefore(ms, (new Date(ms).getDay() + 6) % 7)

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

/** `git diff --numstat` lines, per repo-relative path; a binary file counts no lines. */
const parseNumstat = (out: string): Record<string, FileStat> => {
  const stats: Record<string, FileStat> = {}
  for (const line of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+?)\r?$/.exec(line)
    if (m?.[3] !== undefined) stats[m[3]] = { added: Number(m[1]) || 0, removed: Number(m[2]) || 0 }
  }
  return stats
}

const untrackedPaths = (status: string): string[] =>
  status
    .split('\n')
    .filter(l => l.startsWith('? '))
    .map(l => l.slice(2).trim())

/** A changed file's line counts, matched by its repo-relative path's suffix. */
const statFor = (path: string, stats: Readonly<Record<string, FileStat>> | undefined): FileStat | undefined => {
  if (stats === undefined) return undefined
  for (const [rel, s] of Object.entries(stats)) if (path === rel || path.endsWith(`/${rel}`)) return s
  return undefined
}

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
    const diff = await $.process.run(['git', '--no-optional-locks', 'diff', '--numstat', 'HEAD'], {
      cwd,
      timeoutMs: 5_000,
    })
    const stats = diff.exitCode === 0 ? parseNumstat(diff.stdout) : {}
    let added = 0
    let removed = 0
    for (const s of Object.values(stats)) {
      if (s === 'new') continue
      added += s.added
      removed += s.removed
    }
    for (const path of untrackedPaths(status.stdout)) stats[path] = 'new'
    await update($, gitAtom, () => ({ ...info, added, removed, fileStats: stats }))
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

// ── settings, cache, spend, notifications, files ──────────────────────────

const settingsKey = (key: SurfaceKey): string => `settings.${key}`

/** Reads both surfaces' settings from the store into the session's state. */
const loadSettings = async ($: EngineInterface): Promise<void> => {
  const loaded: Record<string, PanelSettings> = {}
  for (const key of ['terminal', 'desktop'] as const) {
    let raw: unknown
    try {
      raw = await $.store.get(settingsKey(key))
    } catch {
      raw = undefined
    }
    loaded[key] = normalizeSettings(raw, key)
  }
  await update($, settingsAtom, () => loaded)
}

/** Changes one surface's settings, in the session and in the store. */
const changeSettings = async ($: EngineInterface, surface: string, patch: Partial<PanelSettings>): Promise<void> => {
  const key = surfaceKey(surface)
  const all = await update($, settingsAtom, prev => ({ ...prev, [key]: { ...settingsFor(prev, key), ...patch } }))
  try {
    await $.store.set(settingsKey(key), all[key])
  } catch {
    // kept for this session
  }
}

/** The settings of the surface the session draws on first: what an event with no surface of its own follows. */
const primarySettings = async ($: EngineInterface): Promise<PanelSettings> => {
  let surface = 'terminal'
  try {
    surface = (await $.session.surfaces())[0] ?? 'terminal'
  } catch {
    // a host with no surfaces: the terminal's
  }
  return settingsFor(await read($, settingsAtom), surface)
}

const HOST_ENTRYPOINTS: ReadonlySet<string> = new Set(['claude-desktop', 'claude-desktop-3p', 'local-agent'])

const parseTtl = (v: unknown): number | undefined => (v === '1h' ? TTL_1H : v === '5m' ? TTL_5M : undefined)

/**
 * The prompt-cache TTL the engine sends, by its own rule (2.1.317): forced 5m,
 * then an explicit TTL, then forced 1h, then 1h for a claude.ai subscriber (a
 * key in the environment makes a terminal session an API session), else 5m.
 */
const resolveAutoTtl = async ($: EngineInterface): Promise<number> => {
  try {
    if ((await $.env.get('FORCE_PROMPT_CACHING_5M')) !== undefined) return TTL_5M
    const forced = parseTtl(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))
    if (forced !== undefined) return forced
    const configured = parseTtl(await $.settings.read({ key: 'promptCacheTtl' }).catch(() => undefined))
    if (configured !== undefined) return configured
    if ((await $.env.get('ENABLE_PROMPT_CACHING_1H')) !== undefined) return TTL_1H
    const entry = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? ''
    const isHost = HOST_ENTRYPOINTS.has(entry) || (await $.env.get('CLAUDE_CODE_REMOTE')) !== undefined
    const hasKey =
      (await $.env.get('ANTHROPIC_AUTH_TOKEN')) !== undefined || (await $.env.get('ANTHROPIC_API_KEY')) !== undefined
    if (hasKey && !isHost) return TTL_5M
    const scopes = await $.env.get('CLAUDE_CODE_OAUTH_SCOPES')
    if (scopes !== undefined) return scopes.includes('user:inference') ? TTL_1H : TTL_5M
    return TTL_1H
  } catch {
    return TTL_5M
  }
}

const ttlFor = (settings: PanelSettings, cache: CacheClock): number =>
  settings.cacheTtl === '5m' ? TTL_5M : settings.cacheTtl === '1h' ? TTL_1H : cache.autoTtlMs

let cacheTimers: Timer[] = []

/** Redraws once a second through the cache's last minute, so the countdown shows seconds. */
const scheduleCacheTick = async ($: EngineInterface): Promise<void> => {
  for (const t of cacheTimers) t.cancel()
  cacheTimers = []
  const cache = await read($, cacheAtom)
  if (cache.warmAt === undefined) return
  const expiresAt = cache.warmAt + ttlFor(await primarySettings($), cache)
  const now = await $.clock.now()
  if (now > expiresAt) return
  cacheTimers.push(
    $.clock.after(Math.max(0, expiresAt - CACHE_LAST_MINUTE_MS - now), () => {
      const every = $.clock.every(1_000, () => {
        void (async () => {
          const t = await $.clock.now()
          await update($, nowAtom, () => t)
          if (t > expiresAt + 1_000) every.cancel()
        })()
      })
      cacheTimers.push(every)
    }),
  )
}

let lastSpendRefresh = 0

/** Sums what the store holds for every other session and day: today, this week, the last 7 days. */
const refreshSpend = async ($: EngineInterface, isPruning: boolean): Promise<void> => {
  try {
    const now = await $.clock.now()
    lastSpendRefresh = now
    const sid = (await read($, spendAtom)).owner
    const today = localDay(now)
    const monday = weekStart(now)
    const last7 = Array.from({ length: 7 }, (_, i) => dayBefore(now, 6 - i))
    const oldest = dayBefore(now, SPEND_KEEP_DAYS)
    const own = `${SPEND_PREFIX}${today}/${sid}`
    const others: SpendTotals = { today: 0, week: 0, days: [0, 0, 0, 0, 0, 0, 0] }
    for (const key of await $.store.keys()) {
      if (!key.startsWith(SPEND_PREFIX)) continue
      const day = key.slice(SPEND_PREFIX.length, SPEND_PREFIX.length + 10)
      if (day < oldest) {
        if (isPruning) await $.store.delete(key)
        continue
      }
      if (key === own) continue
      const usd = await $.store.get(key)
      if (typeof usd !== 'number' || !(usd > 0)) continue
      if (day === today) others.today += usd
      if (day >= monday) others.week += usd
      const i = last7.indexOf(day)
      if (i >= 0) others.days[i] = (others.days[i] ?? 0) + usd
    }
    await update($, spendAtom, s => ({ ...s, others }))
  } catch {
    // no store: the row counts this session alone
  }
}

/**
 * Names this process's spend keys once: kept in the session's state, so a
 * reload or a /clear keeps booking to the same keys.
 */
const ensureSpendOwner = async ($: EngineInterface, now: number): Promise<void> => {
  await update($, spendAtom, s =>
    s.owner !== '' ? s : { ...s, owner: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}` },
  )
}

/** Books this session's cost against the local day, one store key per day and session. */
const recordSpend = async ($: EngineInterface, usd: number, now: number): Promise<void> => {
  const day = localDay(now)
  const was = await read($, spendAtom)
  if (was.day === day && was.lastUsd === usd) return
  await ensureSpendOwner($, now)
  const s = await update($, spendAtom, prev => {
    // a new day starts from the cost so far; a counter that went back keeps what was booked
    const base =
      prev.day === '' ? 0 : prev.day !== day ? prev.lastUsd : usd < prev.lastUsd ? usd - (prev.lastUsd - prev.base) : prev.base
    return { ...prev, day, base, lastUsd: usd }
  })
  const spent = s.lastUsd - s.base
  if (spent > 0) {
    try {
      await $.store.set(`${SPEND_PREFIX}${day}/${s.owner}`, Math.round(spent * 10_000) / 10_000)
    } catch {
      // counted for this session only
    }
  }
  // past midnight, what the other sessions spent "today" was yesterday's
  if (was.day !== '' && was.day !== day) await refreshSpend($, false)
}

// ── session totals: added per request, saved per session id ───────────────

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

const isEmptyTotals = (t: SessionTotals): boolean =>
  t.turns === 0 && t.input === 0 && t.output === 0 && t.cacheRead === 0 && t.cacheWrite === 0

/** A stored value read back field by field: anything that is not a count is 0. */
const normalizeTotals = (raw: unknown): SessionTotals | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  return {
    input: count(r.input),
    output: count(r.output),
    cacheRead: count(r.cacheRead),
    cacheWrite: count(r.cacheWrite),
    turns: count(r.turns),
    lastInput: count(r.lastInput),
    lastRead: count(r.lastRead),
    lastWrite: count(r.lastWrite),
    ...(typeof r.model === 'string' ? { model: r.model } : {}),
  }
}

/** `b` counted on top of `a`; the latest request's figures are `b`'s once it has any. */
const addTotals = (a: SessionTotals, b: SessionTotals): SessionTotals => {
  const latest = isEmptyTotals(b) ? a : b
  const model = b.model ?? a.model
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    turns: a.turns + b.turns,
    lastInput: latest.lastInput,
    lastRead: latest.lastRead,
    lastWrite: latest.lastWrite,
    ...(model !== undefined ? { model } : {}),
  }
}

let totalsTimer: Timer | undefined

/** Writes the totals under the session they belong to, so a resume picks them up. */
const flushTotals = async ($: EngineInterface): Promise<void> => {
  totalsTimer?.cancel()
  totalsTimer = undefined
  try {
    const { sessionId, ...counts } = await read($, totalsAtom)
    if (sessionId === undefined || isEmptyTotals(counts)) return
    await $.store.set(`${TOTALS_PREFIX}${sessionId}`, { ...counts, savedAt: await $.clock.now() })
  } catch {
    // counted for this run of the session only
  }
}

/** One write per TOTALS_SAVE_MS at most while requests keep coming. */
const saveTotalsSoon = ($: EngineInterface): void => {
  if (totalsTimer !== undefined) return
  try {
    totalsTimer = $.clock.after(TOTALS_SAVE_MS, () => {
      totalsTimer = undefined
      void flushTotals($)
    })
  } catch {
    // the turn's end writes them
  }
}

/**
 * Points the totals at the session the process now runs: a fresh or resumed
 * one loads what its last run saved, one reached by /resume drops the
 * previous session's (saved as it ended), and a reload keeps its own.
 */
const syncTotalsOwner = async ($: EngineInterface): Promise<void> => {
  try {
    const id = await $.session.id()
    const cur = await read($, totalsAtom)
    if (cur.sessionId === id) return
    if (cur.sessionId === undefined && !isEmptyTotals(cur)) {
      // counted in this process by a version that did not name the session
      await update($, totalsAtom, t => ({ ...t, sessionId: id }))
      return
    }
    const saved = normalizeTotals(await $.store.get(`${TOTALS_PREFIX}${id}`).catch(() => undefined)) ?? EMPTY_TOTALS
    await update($, totalsAtom, t => {
      if (t.sessionId === id) return t
      // requests that arrived while the store was read count on top; another session's do not
      return { ...addTotals(saved, t.sessionId === undefined ? t : EMPTY_TOTALS), sessionId: id }
    })
  } catch {
    // a host with no session id: counted for this run only
  }
}

/** Drops the saved totals of sessions untouched for TOTALS_KEEP_DAYS. */
const pruneTotals = async ($: EngineInterface): Promise<void> => {
  try {
    const oldest = (await $.clock.now()) - TOTALS_KEEP_DAYS * DAY_MS
    for (const key of await $.store.keys()) {
      if (!key.startsWith(TOTALS_PREFIX)) continue
      const v = await $.store.get(key)
      const savedAt = typeof v === 'object' && v !== null ? (v as { savedAt?: unknown }).savedAt : undefined
      if (typeof savedAt !== 'number' || savedAt < oldest) await $.store.delete(key)
    }
  } catch {
    // tried again next session
  }
}

/** One response's usage, the main thread's or a subagent's, added as it ends. */
const addUsage = async ($: EngineInterface, usage: TurnUsage, isMain: boolean): Promise<void> => {
  const input = count(usage.input_tokens)
  const cacheRead = count(usage.cache_read_input_tokens)
  const cacheWrite = count(usage.cache_creation_input_tokens)
  await update($, totalsAtom, prev => ({
    ...prev,
    input: prev.input + input,
    output: prev.output + count(usage.output_tokens),
    cacheRead: prev.cacheRead + cacheRead,
    cacheWrite: prev.cacheWrite + cacheWrite,
    ...(isMain ? { lastInput: input, lastRead: cacheRead, lastWrite: cacheWrite, model: usage.model } : {}),
  }))
  saveTotalsSoon($)
}

/** Today, this week and the last 7 days, this session included. */
const spendShown = (s: SpendState, now: number): SpendTotals => {
  const mine = s.day === localDay(now) ? Math.max(0, s.lastUsd - s.base) : 0
  const days = [...s.others.days]
  days[days.length - 1] = (days[days.length - 1] ?? 0) + mine
  return { today: s.others.today + mine, week: s.others.week + mine, days }
}

// Windows PowerShell's own AppUserModelID, so the toast needs no registration
const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** A PowerShell script raising a two-line Windows toast through the built-in WinRT API. */
const toastScript = (title: string, body: string): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    "$t = $x.GetElementsByTagName('text')",
    `[void]$t.Item(0).AppendChild($x.CreateTextNode(${psQuote(title)}))`,
    `[void]$t.Item(1).AppendChild($x.CreateTextNode(${psQuote(body)}))`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(POWERSHELL_APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join('; ')

/** Tells the person a long turn is done: a Windows toast, else their own notification channel. */
const notifyDone = async ($: EngineInterface, durationMs: number, answer: string): Promise<void> => {
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {
    // titled without the folder
  }
  const title = `Claude Code · ${basename(cwd) || 'session'}`
  const said = clean(answer, 80)
  const body = `done in ${fmtSeconds(durationMs)}${said === '' ? '' : ` · ${said}`}`
  if ((await $.env.get('OS')) === 'Windows_NT') {
    await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', toastScript(title, body)], {
      timeoutMs: 15_000,
    })
  } else {
    await $.ui.notify(body, { title })
  }
}

/** Notes a file a successful write tool changed, newest last, its path with forward slashes. */
const recordFile = async ($: EngineInterface, args: Readonly<Record<string, unknown>>): Promise<void> => {
  const raw = typeof args.file_path === 'string' ? args.file_path : args.notebook_path
  if (typeof raw !== 'string' || raw === '') return
  const path = raw.replace(/\\/g, '/')
  const at = await $.clock.now()
  await update($, filesAtom, list => [...list.filter(f => f.path !== path), { path, at }].slice(-MAX_FILES))
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

/** A capsule's icon: the glyph a text surface draws and the shape an SVG draws. */
type PillIcon = { glyph: string; shape: 'sparkle' | 'brain' | 'pen' | 'wrench' | 'spin' }

// One turn a second. The spinner turns inside its own SVG (SMIL), drawn in a
// frame Claude Desktop keeps across redraws only while the frame's markup,
// alt and size stay byte for byte the same: an image is rebuilt on every
// redraw, so swapping images never animated, and a frame whose markup carries
// the label or the colour is rebuilt, and restarts, whenever those change.
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

/**
 * The capsule's SVG and its width in CSS pixels, sized to what it says: the
 * same padding at both ends, the icon always `PILL_PAD` from the left edge.
 * `isSlotEmpty` leaves the icon out, for the spinner laid over it.
 */
const pillSvg = (icon: PillIcon, label: string, bg: string, isSlotEmpty: boolean): { source: string; width: number } => {
  const chars = Array.from(label).length
  const textW = Math.round(chars * PILL_ADVANCE * 10) / 10
  const w = Math.ceil(2 * PILL_PAD + ICON_BOX + (chars === 0 ? 0 : ICON_GAP + textW))
  const h = PILL_H
  const textX = PILL_PAD + ICON_BOX + ICON_GAP
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${bg}"/>` +
    (isSlotEmpty ? '' : `<g transform="translate(${PILL_PAD} ${(h - ICON_BOX) / 2})">${iconShape(icon, C.base, bg)}</g>`) +
    (chars === 0
      ? ''
      : `<text x="${textX}" y="${Math.round(PILL_BASELINE * 10) / 10}"` +
        ` font-family="ui-monospace, 'Cascadia Mono', Consolas, Menlo, monospace" font-size="${PILL_FONT}" font-weight="600"` +
        ` fill="${C.base}" textLength="${textW}" lengthAdjust="spacingAndGlyphs">${escapeXml(label)}</text>`) +
    `</svg>`
  return { source, width: w }
}

// The spinner: one frame whose markup never changes, laid over the capsule's
// empty icon slot, so a new label or colour beneath it leaves it turning. Its
// own background is clear; its colour and font are written on the root so the
// surface never adds its own (which it would reread, and could change, per redraw).
const SPINNER_W = PILL_PAD + ICON_BOX + 1
const SPINNER_ALT = 'working'
const SPINNER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SPINNER_W}" height="${PILL_H}" viewBox="0 0 ${SPINNER_W} ${PILL_H}"` +
  ` color="${C.base}" font-family="monospace">` +
  `<g transform="translate(${PILL_PAD} ${(PILL_H - ICON_BOX) / 2})">${iconShape({ glyph: '', shape: 'spin' }, C.base, 'none')}</g>` +
  `</svg>`

/**
 * A capsule label: Nerd Font half-circle caps in the terminal, an SVG capsule
 * where the surface draws one (Claude Desktop), a plain colored block in a
 * terminal without the caps. Sized to its content, and never squeezed by a
 * long line beside it.
 */
const pill = (ui: Ui, look: Look, icon: PillIcon, label: string, bg: string) => {
  const Svg = ui.Svg
  if (look.isVector && Svg !== undefined) {
    const isSpinning = icon.shape === 'spin'
    const { source, width } = pillSvg(icon, label, bg, isSpinning)
    return (
      <ui.Box flexShrink={0}>
        <Svg source={source} alt={label} width={width} height={PILL_H} isInteractive={false} />
        {isSpinning && (
          <ui.Box position="absolute" top={0} left={0}>
            <Svg source={SPINNER_SVG} alt={SPINNER_ALT} width={SPINNER_W} height={PILL_H} isInteractive />
          </ui.Box>
        )}
      </ui.Box>
    )
  }
  if (look.icons.capL === '') {
    return (
      <ui.Box flexShrink={0}>
        <ui.Text color={C.base} backgroundColor={bg} weight="semibold">
          {` ${icon.glyph} ${label} `}
        </ui.Text>
      </ui.Box>
    )
  }
  return (
    <ui.Box flexShrink={0}>
      <ui.Text>
        <ui.Text color={bg}>{look.icons.capL}</ui.Text>
        <ui.Text color={C.base} backgroundColor={bg} weight="semibold">
          {`${icon.glyph} ${label}`}
        </ui.Text>
        <ui.Text color={bg}>{look.icons.capR}</ui.Text>
      </ui.Text>
    </ui.Box>
  )
}

// Section icons drawn as shapes where the surface's own font would pick the
// glyphs (Claude Desktop): one stroke, one box, upright whatever the font.
// Drawn on a 24-unit grid at 12px, so a 3.2 stroke is 1.6px.
const ICON_PX = 12

type IconName =
  | 'context'
  | 'cache'
  | 'tokens'
  | 'cost'
  | 'limits'
  | 'reset'
  | 'warn'
  | 'activity'
  | 'speed'
  | 'agent'
  | 'branch'
  | 'todo'
  | 'timer'
  | 'gear'
  | 'spend'
  | 'files'

const dot = (cx: number, cy: number, r: number, c: string) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" stroke="none"/>`

const ICON_SHAPES: { readonly [K in IconName]: (c: string) => string } = {
  context: c =>
    `<rect x="3" y="3" width="18" height="18" rx="4"/>` +
    `<path d="M7 3H12V21H7A4 4 0 0 1 3 17V7A4 4 0 0 1 7 3Z" fill="${c}" stroke="none"/>`,
  cache: () =>
    `<ellipse cx="12" cy="6" rx="8" ry="3"/>` +
    `<path d="M4 6V18C4 19.66 7.58 21 12 21S20 19.66 20 18V6M4 12C4 13.66 7.58 15 12 15S20 13.66 20 12"/>`,
  tokens: () => `<path d="M7 20V4M3 8L7 4L11 8M17 4V20M13 16L17 20L21 16"/>`,
  cost: () =>
    `<path d="M12 2V22M17 6.5C16.2 5 14.4 4 12 4C9.2 4 7 5.5 7 7.8C7 12.8 17 10.8 17 16.2C17 18.5 14.8 20 12 20C9.4 20 7.4 18.9 6.7 17.2"/>`,
  limits: () => `<circle cx="12" cy="12" r="9"/><path d="M12 7V12L15.5 14.2"/>`,
  reset: () => `<path d="M20.5 12A8.5 8.5 0 1 1 17.8 5.8L20.5 8.5"/><path d="M20.5 3.5V8.5H15.5"/>`,
  warn: c => `<path d="M12 3.5L21.5 20H2.5Z"/><path d="M12 10V14"/>${dot(12, 17, 1.4, c)}`,
  activity: () => `<path d="M2 12H6L9 5L15 19L18 12H22"/>`,
  speed: () => `<path d="M4.2 17.5A9 9 0 1 1 19.8 17.5"/><path d="M12 14L16 9"/>`,
  agent: c =>
    `<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V5"/>` +
    `${dot(12, 3.5, 1.6, c)}${dot(9, 14, 1.5, c)}${dot(15, 14, 1.5, c)}`,
  branch: () =>
    `<path d="M6 3V15"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9A9 9 0 0 1 9 18"/>`,
  todo: () => `<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12.5L11 15.5L16.5 9.5"/>`,
  timer: () => `<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5V13.5L14.5 15M9.5 2.5H14.5M12 2.5V6"/>`,
  gear: () =>
    `<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.2"/>` +
    `<path d="M12 2.5V6M12 18V21.5M2.5 12H6M18 12H21.5M5.3 5.3L7.8 7.8M16.2 16.2L18.7 18.7M5.3 18.7L7.8 16.2M16.2 7.8L18.7 5.3"/>`,
  spend: () => `<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10H21M8 3V7M16 3V7"/>`,
  files: () =>
    `<path d="M14 3H7A3 3 0 0 0 4 6V18A3 3 0 0 0 7 21H17A3 3 0 0 0 20 18V9Z"/><path d="M14 3V9H20M8 13H16M8 17H13"/>`,
}

const iconSvg = (name: IconName, color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_PX}" height="${ICON_PX}" viewBox="0 0 24 24"` +
  ` fill="none" stroke="${color}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">` +
  `${ICON_SHAPES[name](color)}</svg>`

/** A section icon: a vector shape on a surface that draws SVG, else the icon set's glyph. */
const icon = (ui: Ui, look: Look, name: IconName, color: string): RenderNode => {
  const Svg = ui.Svg
  if (look.isVector && Svg !== undefined) {
    return <Svg source={iconSvg(name, color)} alt={name} width={ICON_PX} height={ICON_PX} isInteractive={false} />
  }
  return <ui.Text color={color}>{look.icons[name]}</ui.Text>
}

/** Spaces that keep their width on every surface (a wrapping line would let trailing ones hang). */
const space = (ui: Ui, n: number) => <ui.Text wrap="truncate-end">{' '.repeat(n)}</ui.Text>

/** An icon and a figure after it, kept on one line; `lead` spaces before the icon. */
const iconLabel = (ui: Ui, look: Look, name: IconName, color: string, text: string, lead = 0) => (
  <ui.Box flexDirection="row" alignItems="center" flexShrink={0}>
    {lead > 0 && space(ui, lead)}
    {icon(ui, look, name, color)}
    <ui.Text color={color} wrap="truncate-end" tabular>{` ${text}`}</ui.Text>
  </ui.Box>
)

const sectionHeader = (ui: Ui, look: Look, name: IconName, label: string, accent: string, right?: RenderNode) => (
  <ui.Box flexDirection="row" justifyContent="space-between" alignItems="center">
    <ui.Box flexDirection="row" alignItems="center" flexShrink={0}>
      {icon(ui, look, name, accent)}
      <ui.Text color={accent} weight="semibold">{` ${label}`}</ui.Text>
    </ui.Box>
    {right ?? <ui.Text> </ui.Text>}
  </ui.Box>
)

const metricRow = (ui: Ui, look: Look, name: IconName, label: string, accent: string, body: RenderNode[]) => (
  <ui.Box flexDirection="row" alignItems="center">
    <ui.Box flexDirection="row" alignItems="center" flexShrink={0}>
      {icon(ui, look, name, accent)}
      <ui.Text color={C.subtext} weight="semibold" wrap="truncate-end">
        {` ${label.padEnd(7)}`}
      </ui.Text>
    </ui.Box>
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
  fill: string = thresholdColor(pct),
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
    for (let k = 0; k < filled; k++) cells.push({ ch: LINE, color: fill })
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

// ── compaction ────────────────────────────────────────────────────────────

/** The average rise of the context per turn, over the recent turns that grew it. */
const growthPerTurn = (history: readonly number[]): number | undefined => {
  const rises = history.slice(1).flatMap((v, i) => {
    const d = v - (history[i] ?? v)
    return d > 0 ? [d] : []
  })
  return rises.length === 0 ? undefined : rises.reduce((a, b) => a + b, 0) / rises.length
}

/** What the forecast line says: a recent compaction, else how many turns until the auto-compact. */
const compactNote = (
  last: { before?: number; after?: number; at: number } | null,
  threshold: number | undefined,
  tokens: number | undefined,
  history: readonly number[],
  clock: number,
): string | undefined => {
  if (last !== null && clock - last.at < COMPACT_SHOWN_MS) {
    return last.before !== undefined && last.after !== undefined
      ? `compacted ${fmtTokens(last.before)} → ${fmtTokens(last.after)}`
      : 'compacted'
  }
  if (threshold === undefined || tokens === undefined) return undefined
  if (tokens >= threshold) return 'auto-compact due'
  const growth = growthPerTurn(history)
  if (growth === undefined) return undefined
  const turns = Math.max(1, Math.ceil((threshold - tokens) / growth))
  return `≈${turns} turn${turns === 1 ? '' : 's'} to auto-compact`
}

/** Notes a compaction: the forecast line shows it for a while, and the growth history starts over. */
const noteCompaction = async ($: EngineInterface, before: number | undefined, after: number | undefined): Promise<void> => {
  const at = await $.clock.now()
  await update($, lastCompactAtom, () => ({ before, after, at }))
  await update($, ctxHistoryAtom, () => [])
  void refreshBreakdown($)
}

/**
 * "compact now": the first press arms it for a few seconds, the second
 * compacts. A plugin's own compaction passes by its own session.compact hook,
 * so the result is noted here.
 */
const pressCompact = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  // an arm a reload orphaned has lapsed all the same
  if ((await read($, compactArmedAtom)) < now) {
    const until = now + COMPACT_ARM_MS
    await update($, compactArmedAtom, () => until)
    $.clock.after(COMPACT_ARM_MS, () => {
      void update($, compactArmedAtom, v => (v === until ? 0 : v))
    })
    return
  }
  await update($, compactArmedAtom, () => 0)
  try {
    const result = await $.session.compact()
    if (result.skip !== undefined) $.ui.toast(`Compact skipped: ${result.skip}`)
    else await noteCompaction($, result.tokensBefore, result.tokensAfter)
  } catch (error) {
    $.ui.toast(`Compact failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── settings page ─────────────────────────────────────────────────────────

type SettingRow = { id: string; label: string; value: string; isOn: boolean; patch: Partial<PanelSettings> }

const nextOf = <T,>(list: readonly T[], value: T): T => list[(list.indexOf(value) + 1) % list.length] ?? value

const settingRows = (surface: string, s: PanelSettings, cache: CacheClock): SettingRow[] => {
  const flag = (id: 'band' | 'sound' | 'notify' | 'git' | 'cacheTimer' | 'spend' | 'compactForecast' | 'versions', label: string) => ({
    id,
    label,
    value: s[id] ? 'on' : 'off',
    isOn: s[id],
    patch: { [id]: !s[id] },
  })
  const rows: SettingRow[] = [
    flag('band', 'Activity band'),
    flag('sound', 'Completion sound'),
    flag('notify', 'Long-turn notification'),
    {
      id: 'notifyAfterS',
      label: '  after',
      value: `${s.notifyAfterS}s`,
      isOn: s.notify,
      patch: { notifyAfterS: nextOf<number>(NOTIFY_STEPS, s.notifyAfterS) },
    },
    flag('git', 'Git & changed files'),
    flag('cacheTimer', 'Cache countdown'),
    {
      id: 'cacheTtl',
      label: '  TTL',
      value: s.cacheTtl === 'auto' ? `auto (${cache.autoTtlMs === TTL_1H ? '1h' : '5m'})` : s.cacheTtl,
      isOn: s.cacheTimer,
      patch: { cacheTtl: nextOf(['auto', '5m', '1h'] as const, s.cacheTtl) },
    },
    flag('spend', 'Today / week spend'),
    flag('compactForecast', 'Compact forecast'),
    flag('versions', 'Versions'),
  ]
  if (surface === 'terminal') {
    rows.push({
      id: 'icons',
      label: 'Icons',
      value: s.icons,
      isOn: true,
      patch: { icons: s.icons === 'nerd' ? 'unicode' : 'nerd' },
    })
  }
  return rows
}

const surfaceName = (surface: string): string => (surface === 'terminal' ? 'the terminal' : 'Claude Desktop')

/** The settings page that takes the pane's place while it is open: this surface's settings. */
const settingsPage = ($: EngineInterface, ui: Ui, look: Look, surface: string, s: PanelSettings, cache: CacheClock) => (
  <ui.Box flexDirection="column" paddingX={1}>
    <ui.Button key="settings-back" plain dimColor label="← back" onPress={() => update($, paneViewAtom, () => 'dash')} />
    {gap(ui)}
    {sectionHeader(ui, look, 'gear', 'SETTINGS', C.mauve)}
    {settingRows(surface, s, cache).map(r => (
      <ui.Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <ui.Text color={r.isOn ? C.text : C.overlay0} wrap="truncate-end">
          {r.label}
        </ui.Text>
        <ui.Button
          key={`set-${r.id}`}
          plain
          dimColor={!r.isOn}
          label={r.value}
          onPress={() => changeSettings($, surface, r.patch)}
        />
      </ui.Box>
    ))}
    {gap(ui)}
    <ui.Text color={C.overlay0} size="footnote">
      {`These apply to ${surfaceName(surface)} only.`}
    </ui.Text>
  </ui.Box>
)

// ── hooks ─────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'panel', description: 'Toggle the usage panel', immediate: true })
    } catch (error) {
      $.ui.toast(`capsule-panel: /panel failed to register ${String(error)}`)
    }

    void (async () => {
      await syncTotalsOwner($)
      await loadSettings($)
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
        await update($, modelInfoAtom, prev => ({ ...prev, model: prev.model ?? model }))
        await update($, nowAtom, () => now)
        // a resumed session's cost so far was booked by the session that spent it
        const usd = usage.cost?.usd ?? 0
        await update($, spendAtom, s => (s.day === '' ? { ...s, day: localDay(now), base: usd, lastUsd: usd } : s))
        await ensureSpendOwner($, now)
      } catch {
        // placeholders stay until session.measure fills them
      }
      try {
        const effort = await $.env.get('CLAUDE_EFFORT')
        if (effort !== undefined) await update($, modelInfoAtom, prev => ({ ...prev, effort: prev.effort ?? effort }))
      } catch {
        // the first turn names it
      }
      try {
        const { version, base } = await $.session.version()
        const desktop = await $.env.get('CLAUDE_CODE_DESKTOP_APP_VERSION').catch(() => undefined)
        await update($, versionsAtom, () => ({ cli: base ?? version, desktop }))
      } catch {
        // the footer leaves them out
      }
      const autoTtlMs = await resolveAutoTtl($)
      await update($, cacheAtom, c => ({ ...c, autoTtlMs }))
      await scheduleCacheTick($)
      await refreshSpend($, true)
      await refreshAgents($)
      await refreshGit($)
      await refreshBreakdown($)
      await pruneTotals($)
    })()

    void (async () => {
      if (!(await read($, dismissedAtom))) await openPane($)
      if ((await read($, workAtom)).isWorking) ensureTicker($)
    })()

    $.clock.every(HEARTBEAT_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        await update($, nowAtom, () => now)
        if (now - lastSpendRefresh >= SPEND_REFRESH_MS || localDay(now) !== localDay(lastSpendRefresh)) {
          await refreshSpend($, false)
        }
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
    if (e.cost !== undefined) await recordSpend($, e.cost.usd, now)
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
    // a subagent's run belongs to the main turn that spawned it, and may outlast it
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    live = { chars: 0, firstAt: 0, phase: 'thinking' }
    await update($, workAtom, w => ({ ...w, isWorking: true, startedAt: now }))
    ensureTicker($)
    // a /resume or /clear since the last turn moved the process to another session
    await syncTotalsOwner($)
    await update($, totalsAtom, t => ({ ...t, turns: t.turns + 1 }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    if (e.agentId !== undefined) {
      // a subagent's requests count toward the session's tokens, as they do toward its cost
      for await (const chunk of stream) {
        if (chunk.kind === 'stop' && chunk.usage != null) await addUsage($, chunk.usage, false)
        yield chunk
      }
      return await stream.result
    }

    const effort = effortText(e.effort)
    const info = await read($, modelInfoAtom)
    if (info.model !== e.model || (effort !== undefined && info.effort !== effort)) {
      await update($, modelInfoAtom, prev => ({ model: e.model, effort: effort ?? prev.effort }))
    }

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
        // counted as each response ends, so a long turn's figures move while it runs
        if (chunk.usage != null) await addUsage($, chunk.usage, true)
        // the request wrote or read the prompt cache: its TTL runs from here
        const stoppedAt = await $.clock.now()
        await update($, cacheAtom, c => ({ ...c, warmAt: stoppedAt }))
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
    if (e.agentId !== undefined) {
      // a subagent's calls stay out of the activity list, but its edits are changes all the same
      if (!FILE_TOOLS.has(e.tool)) return next(e)
      const done = await next(e)
      if (done.deny === undefined && done.isError !== true) {
        await recordFile($, e as unknown as Readonly<Record<string, unknown>>)
        scheduleGit($)
      }
      return done
    }

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
      if (FILE_TOOLS.has(e.tool)) await recordFile($, args)
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

    // the turn's requests were added up as each one ended
    void flushTotals($)

    const now = await $.clock.now()
    live = { chars: 0, firstAt: 0, phase: 'idle' }
    await update($, workAtom, w => ({ ...w, isWorking: false, animUntil: Math.max(w.animUntil, now + TWEEN_MS) }))
    // a call cut off by an interrupt never reports back
    await update($, activityAtom, list =>
      list.map(x => (x.status === 'running' ? { ...x, status: 'error', durationMs: now - x.startedAt } : x)),
    )
    scheduleGit($)
    void refreshAgents($)

    const tokens = (await read($, snapshotAtom))?.context.tokens
    if (tokens !== undefined) await update($, ctxHistoryAtom, h => [...h, tokens].slice(-CTX_HISTORY))
    // the turn's last request just read or wrote the cache
    await update($, cacheAtom, c => ({ ...c, warmAt: now }))
    void scheduleCacheTick($)

    const settings = await primarySettings($)
    // a Windows terminal has no player and plays nothing; elsewhere a short tone
    if (settings.sound && !e.isAborted) {
      void $.audio.play({ asset: DONE_SOUND }, { gain: 0.6 }).catch(() => undefined)
    }
    if (settings.notify && e.reason === 'answer' && e.durationMs >= settings.notifyAfterS * 1000) {
      void notifyDone($, e.durationMs, e.answer).catch(() => undefined)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // saved under the ending session, which a later resume returns to
    await flushTotals($)
    if (e.reason === 'resume') {
      // the process goes on as another session: its own totals load once its id is in place
      try {
        $.clock.after(1_000, () => void syncTotalsOwner($))
      } catch {
        // the next turn's start loads them
      }
      return next(e)
    }
    if (e.reason !== 'clear') return next(e)

    await update($, totalsAtom, () => ({ ...EMPTY_TOTALS }))
    await update($, snapshotAtom, () => null)
    await update($, breakdownAtom, () => null)
    await update($, activityAtom, () => [])
    await update($, streamAtom, () => ({ rates: [] }))
    await update($, todosAtom, () => [])
    await update($, filesAtom, () => [])
    await update($, ctxHistoryAtom, () => [])
    await update($, lastCompactAtom, () => null)
    await update($, cacheAtom, c => ({ autoTtlMs: c.autoTtlMs }))
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || result.skip !== undefined) return result
    await noteCompaction($, result.tokensBefore, result.tokensAfter)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const ui: Ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const settings = settingsFor(await read($, settingsAtom), e.surface)
    const look = lookFor(e.surface, iconChoice(e.surface, settings))
    const { icons } = look
    if ((await read($, paneViewAtom)) === 'settings') {
      return settingsPage($, ui, look, e.surface, settings, await read($, cacheAtom))
    }
    const [snapshot, totals, breakdown, samples, activity, stream, agents, todos, git, work, frame, now] =
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
        read($, nowAtom),
      ])
    const [modelInfo, versions, cache, spend, ctxHistory, lastCompact, compactArmed, files] = await Promise.all([
      read($, modelInfoAtom),
      read($, versionsAtom),
      read($, cacheAtom),
      read($, spendAtom),
      read($, ctxHistoryAtom),
      read($, lastCompactAtom),
      read($, compactArmedAtom),
      read($, filesAtom),
    ])

    const W = Math.max(28, e.props.bodyColumns - 2)
    const clock = Math.max(now, frame.at)
    const isWorking = work.isWorking
    const t = tweenProgress(snapshot, frame.at)
    const breath = RED_BREATH[frame.n % RED_BREATH.length] ?? C.red
    // a figure at or past HOT_PCT pulses while Claude works, and holds still red otherwise
    const hotColor = (pct: number | undefined): string =>
      isWorking && (pct ?? 0) >= HOT_PCT ? breath : thresholdColor(pct)

    // header
    const startedAt = snapshot?.startedAt
    const elapsed = startedAt === undefined ? '—' : fmtElapsed(clock - startedAt)
    const liveColor = isWorking ? (BREATH[frame.n % BREATH.length] ?? C.teal) : C.overlay0
    const model = modelInfo.model ?? totals.model
    const modelLine = [model === undefined ? undefined : shortModel(model), modelInfo.effort]
      .filter((x): x is string => x !== undefined && x !== '')
      .join(' · ')

    // context
    const ctx = snapshot?.context
    const pct = ctx?.percent
    const pctShown = tween(snapshot?.prev?.percent, pct, t)
    const tokShown = tween(snapshot?.prev?.tokens, ctx?.tokens, t)
    const legend = [...(breakdown?.slices ?? [])].sort((a, b) => b.tokens - a.tokens).slice(0, 4)
    const note = settings.compactForecast
      ? compactNote(lastCompact, breakdown?.threshold, ctx?.tokens, ctxHistory, clock)
      : undefined
    const showsCompact = settings.compactForecast && !isWorking && ctx?.tokens !== undefined
    const isArmed = compactArmed > clock

    // usage
    const hit = hitRate(totals.cacheRead, totals.cacheWrite, totals.input)
    const hitColor = hit === undefined ? C.overlay0 : hit >= 70 ? C.green : hit >= 40 ? C.yellow : C.peach
    const warmLeft =
      settings.cacheTimer && !isWorking && cache.warmAt !== undefined
        ? cache.warmAt + ttlFor(settings, cache) - clock
        : undefined
    const costShown = tween(snapshot?.prev?.costUsd, snapshot?.costUsd, t)
    const hours = startedAt === undefined ? 0 : (clock - startedAt) / 3_600_000
    const limits = snapshot?.rateLimits ?? []
    const perHour = hours >= 1 / 30 && snapshot?.costUsd !== undefined ? snapshot.costUsd / hours : undefined
    const tokTotal = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
    const tokPerHour = hours >= 1 / 30 ? tokTotal / hours : undefined
    const spent = spendShown(spend, clock)
    const showsSpend = settings.spend && (snapshot?.costUsd !== undefined || spent.week > 0)

    // activity
    const lastRate = stream.rates[stream.rates.length - 1]
    const shownRate = isWorking && frame.liveRate !== undefined ? frame.liveRate : lastRate
    const recent = activity.slice(-SHOWN_ACTIVITY).reverse()

    // changes
    const showsGit = settings.git && git !== null
    const changed = settings.git ? [...files].reverse() : []

    // todos
    const done = todos.filter(x => x.status === 'completed').length
    const current = todos.find(x => x.status === 'in_progress')

    const limitBarW = Math.max(6, W - 27)
    const versionLine = settings.versions
      ? [versions.cli === undefined ? '' : `CC ${versions.cli}`, versions.desktop === undefined ? '' : `Desktop ${versions.desktop}`]
          .filter(x => x !== '')
          .join(' · ')
      : ''

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" alignItems="center" flexShrink={1} minWidth={0}>
            {pill(ui, look, { glyph: icons.sparkle, shape: 'sparkle' }, 'USAGE', C.mauve)}
            {modelLine !== '' && (
              <Text color={C.overlay0} wrap="truncate-end">
                {` ${modelLine}`}
              </Text>
            )}
          </Box>
          <Box flexShrink={0}>
            <Text wrap="truncate-end">
              <Text color={liveColor}>{isWorking ? icons.dot : icons.dotIdle}</Text>
              <Text color={isWorking ? C.teal : C.overlay0}>{isWorking ? ' live' : ' idle'}</Text>
              <Text color={C.overlay0} tabular>{`  ${elapsed}`}</Text>
            </Text>
          </Box>
        </Box>
        {gap(ui)}

        {sectionHeader(
          ui,
          look,
          'context',
          'CONTEXT',
          thresholdColor(pct),
          <Text tabular wrap="truncate-end">
            <Text color={C.subtext}>
              {ctx === undefined
                ? '— / — '
                : `${tokShown === undefined ? '—' : fmtTokens(tokShown)} / ${fmtTokens(ctx.window)} `}
            </Text>
            <Text color={hotColor(pct)} weight="semibold">
              {pctText(pctShown)}
            </Text>
          </Text>,
        )}
        {drawCells(
          ui,
          contextCells(W, pctShown, breakdown, ctx?.window ?? 0, isWorking ? frame.n : undefined, hotColor(pct)),
        )}
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
        {(note !== undefined || showsCompact) && (
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text color={note?.startsWith('compacted') === true ? C.teal : C.overlay0} size="footnote" wrap="truncate-end">
                {note ?? ' '}
              </Text>
            </Box>
            {showsCompact && (
              <Button
                key="compact"
                plain
                dimColor={!isArmed}
                label={isArmed ? 'press again to compact' : 'compact now'}
                onPress={() => pressCompact($)}
              />
            )}
          </Box>
        )}
        {gap(ui)}

        {metricRow(ui, look, 'cache', 'CACHE', C.teal, [
          <Text color={hitColor} weight="semibold" tabular>
            {hit === undefined ? '—' : `${hit}% hit`}
          </Text>,
          warmLeft === undefined ? (
            <Text> </Text>
          ) : warmLeft <= 0 ? (
            <Text color={mix(C.red, C.overlay0, 0.4)}>{'  cold'}</Text>
          ) : warmLeft < CACHE_LAST_MINUTE_MS ? (
            <Text color={C.yellow} tabular>{`  warm ${fmtClock(warmLeft)}`}</Text>
          ) : (
            <Text color={C.teal} tabular>{`  warm ${fmtSpan(warmLeft)}`}</Text>
          ),
          <Text color={C.overlay0} tabular>{`  R ${fmtTokens(totals.cacheRead)}  W ${fmtTokens(totals.cacheWrite)}`}</Text>,
        ])}
        {metricRow(ui, look, 'tokens', 'TOKENS', C.blue, [
          <Text color={C.text} tabular>{`↑ ${fmtTokens(totals.input)}  ↓ ${fmtTokens(totals.output)}`}</Text>,
          <Text color={C.overlay0} tabular>{`  ${totals.turns} turn${totals.turns === 1 ? '' : 's'}`}</Text>,
        ])}
        {metricRow(ui, look, 'cost', 'COST', C.peach, [
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
        {showsSpend &&
          metricRow(ui, look, 'spend', 'SPEND', C.yellow, [
            <Text color={C.yellow} weight="semibold" tabular>{`today ${fmtUsd(spent.today)}`}</Text>,
            <Text color={C.overlay0} tabular>{`  wk ${fmtUsd(spent.week)}  `}</Text>,
            ...runs(sparkCells(spent.days, 7)).map(r => <Text color={r.color}>{r.ch}</Text>),
          ])}

        {limits.length > 0 && gap(ui)}
        {limits.length > 0 && sectionHeader(ui, look, 'limits', 'LIMITS', C.sapphire)}
        {limits.map(l => {
          const burn = burnFor(samples[l.kind], l.percentUsed, l.resetsAt, clock)
          const resetIn = l.resetsAt === undefined ? undefined : Date.parse(l.resetsAt) - clock
          const color = hotColor(l.percentUsed)
          return (
            <Box flexDirection="row" alignItems="center">
              <Text color={C.subtext} wrap="truncate-end">{shortKind(l.kind).padEnd(3)}</Text>
              {drawCells(ui, barCells(limitBarW, l.percentUsed, color))}
              <Text color={color} weight="semibold" wrap="truncate-end" tabular>{` ${pctText(l.percentUsed).padStart(4)}`}</Text>
              {resetIn !== undefined && !Number.isNaN(resetIn) && iconLabel(ui, look, 'reset', C.overlay0, fmtSpan(resetIn), 2)}
              {burn !== undefined &&
                (burn.isShort ? (
                  iconLabel(ui, look, 'warn', C.red, `~${fmtSpan(burn.etaMs)}`, 2)
                ) : (
                  <Text color={C.green} wrap="truncate-end">{'  ✓'}</Text>
                ))}
            </Box>
          )
        })}
        {gap(ui)}

        {sectionHeader(
          ui,
          look,
          'activity',
          'ACTIVITY',
          C.lavender,
          shownRate === undefined
            ? undefined
            : iconLabel(ui, look, 'speed', isWorking ? C.teal : C.overlay0, `${Math.round(shownRate)} tok/s`),
        )}
        {stream.rates.length >= 2 && drawCells(ui, sparkCells(stream.rates, W))}
        {recent.map(a => {
          const glyph = statusGlyph(a.status, frame.n, look.pie)
          const ms = a.status === 'running' ? clock - a.startedAt : (a.durationMs ?? 0)
          // a new row lights up and fades to its colours over the first second
          const age = frame.at - a.startedAt
          const glow = isWorking && age >= 0 && age < FLASH_MS ? 1 - age / FLASH_MS : 0
          return (
            <Box flexDirection="row">
              <Text color={glyph.color}>{`${glyph.ch} `}</Text>
              <Text color={glow > 0 ? mix(C.blue, C.text, glow) : C.blue} weight={a.status === 'running' ? 'semibold' : 'regular'}>
                {toolName(a.tool).padEnd(8)}
              </Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text color={glow > 0 ? mix(C.subtext, C.text, glow) : C.subtext} wrap="truncate-end">
                  {a.summary}
                </Text>
              </Box>
              <Text color={C.overlay0} tabular>{` ${fmtSeconds(ms)}`}</Text>
            </Box>
          )
        })}
        {agents.running > 0 && (
          <Box flexDirection="row" alignItems="center">
            {icon(ui, look, 'agent', C.pink)}
            <Text color={C.pink} wrap="truncate-end">
              {` ${agents.running} agent${agents.running === 1 ? '' : 's'} running`}
              {agents.names.length > 0 && <Text color={C.overlay0}>{` · ${agents.names.join(', ')}`}</Text>}
            </Text>
          </Box>
        )}
        {recent.length === 0 && stream.rates.length < 2 && agents.running === 0 && (
          <Text color={C.overlay0}>no activity yet</Text>
        )}

        {(showsGit || changed.length > 0 || todos.length > 0) && gap(ui)}
        {showsGit && git !== null && (
          <Box flexDirection="row" alignItems="center">
            {icon(ui, look, 'branch', C.green)}
            <Text wrap="truncate-end" size="footnote">
              <Text color={C.green} weight="semibold">
                {` ${clean(git.branch, 24)}`}
              </Text>
              <Text color={C.overlay0}>{git.ahead + git.behind > 0 ? ` ↑${git.ahead} ↓${git.behind}` : ''}</Text>
              {git.added + git.removed > 0 && <Text color={C.green}>{`  +${git.added}`}</Text>}
              {git.added + git.removed > 0 && <Text color={C.red}>{` −${git.removed}`}</Text>}
              <Text color={C.overlay0}>{git.files > 0 ? ` · ${git.files} files` : ' · clean'}</Text>
            </Text>
          </Box>
        )}
        {!showsGit && changed.length > 0 && (
          <Box flexDirection="row" alignItems="center">
            {icon(ui, look, 'files', C.green)}
            <Text color={C.green} weight="semibold" size="footnote" wrap="truncate-end">
              {` ${changed.length} file${changed.length === 1 ? '' : 's'} edited`}
            </Text>
          </Box>
        )}
        {changed.slice(0, SHOWN_FILES).map(f => {
          const stat = statFor(f.path, git?.fileStats)
          return (
            <Box flexDirection="row" alignItems="center">
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text color={C.subtext} size="footnote" wrap="truncate-end">
                  {`  ${basename(f.path)}`}
                </Text>
              </Box>
              <Box flexShrink={0}>
                <Text size="footnote" wrap="truncate-end" tabular>
                  {stat === 'new' && <Text color={C.green}>{' new'}</Text>}
                  {stat !== undefined && stat !== 'new' && stat.added + stat.removed > 0 && (
                    <Text>
                      <Text color={C.green}>{` +${stat.added}`}</Text>
                      <Text color={C.red}>{` −${stat.removed}`}</Text>
                    </Text>
                  )}
                </Text>
              </Box>
            </Box>
          )
        })}
        {changed.length > SHOWN_FILES && (
          <Text color={C.overlay0} size="footnote">
            {`  +${changed.length - SHOWN_FILES} more`}
          </Text>
        )}
        {todos.length > 0 && (
          <Box flexDirection="row" alignItems="center">
            {icon(ui, look, 'todo', C.lavender)}
            <Text color={C.lavender} weight="semibold" wrap="truncate-end">{' TODO '}</Text>
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
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Button
            key="open-settings"
            plain
            dimColor
            label={`${icons.gear} settings`}
            onPress={() => update($, paneViewAtom, () => 'settings')}
          />
          {versionLine !== '' && (
            <Text color={C.overlay0} size="footnote" wrap="truncate-end">
              {versionLine}
            </Text>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!e.props.isWorking || e.props.hasSurvey) return next(e)
    const settings = settingsFor(await read($, settingsAtom), e.surface)
    if (!settings.band) return next(e)

    const ui: Ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const look = lookFor(e.surface, iconChoice(e.surface, settings))
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

    // One line whatever the width: the capsule and the figures on the right keep
    // their size, and only the detail between them gives way, cut with an ellipsis.
    // A graphical surface counts columns in its own font, so it fills the band.
    return (
      <Box flexDirection="row" alignItems="center" width={look.isTerminal ? e.props.bodyColumns : '100%'}>
        {pill(ui, look, current.icon, current.label, current.color)}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text color={C.subtext} wrap="truncate-end" tabular>
            {`${detail}${toolMs === undefined ? '' : ` · ${fmtSeconds(toolMs)}`}`}
          </Text>
        </Box>
        <Box flexDirection="row" alignItems="center" flexShrink={0}>
          {rate !== undefined && iconLabel(ui, look, 'speed', C.teal, `${Math.round(rate)} tok/s`, 2)}
          {agents.running > 0 && iconLabel(ui, look, 'agent', C.pink, `${agents.running}`, 2)}
          {turnMs !== undefined && (
            <Text color={C.overlay0} wrap="truncate-end" tabular>{`  ${fmtElapsed(turnMs)}`}</Text>
          )}
        </Box>
      </Box>
    )
  })
}
