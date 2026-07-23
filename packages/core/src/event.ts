export interface AppEvent {
  ts: string
  source: 'web' | 'mcp' | 'cli' | 'sync' | 'system'
  actor: string
  action: string
  target?: { type: string; id: string }
  outcome: 'success' | 'failure'
  durationMs?: number
  error?: { code: string; message: string }
  fields?: Record<string, unknown>
}

export function emitEvent(event: AppEvent): string {
  return JSON.stringify(event)
}
