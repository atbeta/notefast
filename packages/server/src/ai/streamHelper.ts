import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'

type EventLike = { type: string; [key: string]: unknown }

export interface SSEFrame {
  event: string
  data: string
}

/**
 * 将 AsyncGenerator<EventLike> 通过 eventMapper 转为 SSE 帧后写入响应流。
 * 用于 /ai/chat、/ai/write 等需要 SSE 事件流的端点。
 */
export async function pipeEventsToSSE<T extends EventLike>(
  c: Context,
  generator: AsyncGenerator<T>,
  eventMapper: (ev: T) => SSEFrame,
): Promise<Response> {
  return streamSSE(c, async (writer) => {
    for await (const ev of generator) {
      await writer.writeSSE(eventMapper(ev))
    }
  })
}
