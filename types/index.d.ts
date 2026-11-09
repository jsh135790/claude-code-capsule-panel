export type UsageSnapshot = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  costUsd?: number
  startedAt?: number
  /** The figures before the last measure, for the count-up animation. */
  prev?: { tokens?: number; percent?: number; costUsd?: number }
  changedAt?: number
}

/**
 * Every request's usage this session, the main thread's and its subagents',
 * added up as each response ends; `turns` counts the main thread's turns as
 * they start. `sessionId` names the session the counts belong to, the key
 * they are saved under so a resume picks them up.
 */
export type SessionTotals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  turns: number
  lastInput: number
  lastRead: number
  lastWrite: number
  model?: string
  sessionId?: string
}

export type ContextSlice = { label: string; tokens: number }

export type ContextBreakdown = {
  slices: ContextSlice[]
  threshold?: number
}

/** The panel's options for one surface, kept in the plugin's own store. */
export type PanelSettings = {
  band: boolean
  sound: boolean
  notify: boolean
  /** Seconds a turn runs before its end raises a notification. */
  notifyAfterS: number
  git: boolean
  cacheTimer: boolean
  cacheTtl: 'auto' | '5m' | '1h'
  spend: boolean
  compactForecast: boolean
  versions: boolean
  /** The terminal's icon set; other surfaces draw vector icons. */
  icons: 'nerd' | 'unicode'
}

export type PaneView = 'dash' | 'settings'

export type ModelInfo = { model?: string; effort?: string }

export type Versions = { cli?: string; desktop?: string }

/** When the main thread's prompt cache was last written or read, and the TTL `auto` resolves to. */
export type CacheClock = { warmAt?: number; autoTtlMs: number }

export type SpendTotals = { today: number; week: number; days: number[] }

/**
 * This session's spend for the local day `day` (`lastUsd - base`), the cost
 * at the last measure, and what every other session and day in the store add;
 * `owner` names this process's store keys.
 */
export type SpendState = { owner: string; day: string; base: number; lastUsd: number; others: SpendTotals }

export type CompactRecord = { before?: number; after?: number; at: number }

export type ChangedFile = { path: string; at: number }

export type FileStat = { added: number; removed: number } | 'new'

export type RateSample = { t: number; pct: number }

export type ActivityStatus = 'running' | 'ok' | 'error'

export type ActivityEntry = {
  id: string
  tool: string
  summary: string
  startedAt: number
  durationMs?: number
  status: ActivityStatus
}

export type StreamStats = { rates: number[] }

export type AgentSummary = { running: number; names: string[] }

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export type TodoItem = { id: string; subject: string; status: TodoStatus; activeForm?: string }

export type GitInfo = {
  branch: string
  ahead: number
  behind: number
  added: number
  removed: number
  files: number
  /** Per repo-relative path: lines changed against HEAD, or `new` for an untracked file. */
  fileStats?: Record<string, FileStat>
}

export type WorkState = { isWorking: boolean; startedAt?: number; animUntil: number }

export type Phase = 'idle' | 'thinking' | 'responding' | 'tool-input' | 'tools'

/** One tick of the work animation. */
export type Frame = { n: number; at: number; phase: Phase; liveRate?: number }

declare module 'claude-code' {
  interface PluginState {
    'capsule-panel': {
      snapshot: UsageSnapshot | null
      totals: SessionTotals
      isPaneDismissed: boolean
      /** Per surface (`terminal`, `desktop`), mirrored from the store. */
      settings: Record<string, PanelSettings>
      paneView: PaneView
      modelInfo: ModelInfo
      versions: Versions
      cacheClock: CacheClock
      spend: SpendState
      /** The main thread's context tokens at the end of each recent turn. */
      ctxHistory: number[]
      lastCompact: CompactRecord | null
      /** Until when a first press of "compact now" waits for the second. */
      compactArmedUntil: number
      files: ChangedFile[]
      now: number
      breakdown: ContextBreakdown | null
      rateSamples: Record<string, RateSample[]>
      /** Per rate-limit kind, the reset time of the window already warned about. */
      limitWarnings: Record<string, string>
      activity: ActivityEntry[]
      stream: StreamStats
      agents: AgentSummary
      todos: TodoItem[]
      git: GitInfo | null
      work: WorkState
      frame: Frame
    }
  }
}
