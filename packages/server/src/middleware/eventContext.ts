import type { Context, Next } from 'hono'

export interface EventContext {
  source: 'web' | 'mcp' | 'cli' | 'sync' | 'system'
  actor: string
}

declare module 'hono' {
  interface ContextVariableMap {
    eventContext: EventContext
  }
}

export function eventContextMiddleware(c: Context, next: Next) {
  const source = (c.req.header('x-source') as EventContext['source']) || 'web'
  const actor = c.req.header('x-actor') || 'user'
  c.set('eventContext', { source, actor })
  return next()
}
