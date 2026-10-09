export type Limit = { percentUsed: number; resetsAt?: string }
export type Limits = { session: Limit | null; weekly: Limit | null }
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Sample = { at: number; percent: number }
export type Pace = { window: string | null; samples: Sample[] }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      limits: Limits
      costUsd: number | null
      contextPercent: number | null
      model: string | null
      effort: string | null
      tokens: Tokens
      pace: Pace
      warned: string[]
    }
  }
}
