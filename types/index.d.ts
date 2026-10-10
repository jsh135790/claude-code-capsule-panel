export type UsageSnapshot = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  costUsd?: number
  startedAt?: number
  /** The figures before the last measure, for the count-up animation. */
  prev?: { tokens?: number; percent?: number; costUsd?: number }
  changedAt?: number
}

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
}

export type ContextSlice = { label: string; tokens: number }

export type ContextBreakdown = {
  slices: ContextSlice[]
  threshold?: number
}

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
}

export type WorkState = { isWorking: boolean; startedAt?: number; animUntil: number }

export type Phase = 'idle' | 'thinking' | 'responding' | 'tool-input' | 'tools'

export type Frame = { n: number; at: number; phase: Phase; liveRate?: number }

declare module 'claude-code' {
  interface PluginState {
    'capsule-panel': {
      snapshot: UsageSnapshot | null
      totals: SessionTotals
      isBandHidden: boolean
      isPaneDismissed: boolean
      now: number
      breakdown: ContextBreakdown | null
      rateSamples: Record<string, RateSample[]>
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
