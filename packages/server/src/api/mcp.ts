import { Hono } from 'hono'
import { mcpToolRegistry } from '../mcp/tools/helpers'

const mcp = new Hono()

/** MCP 工具清单（设置页「MCP 能力」展示用；registerMcpTools 注册时收集） */
mcp.get('/tools', (c) => {
  return c.json(mcpToolRegistry)
})

export default mcp
