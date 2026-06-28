import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { registerMcpTools } from './tools'

export async function createMcpTransport(notebookId: string): Promise<WebStandardStreamableHTTPServerTransport> {
  const serverName = process.env.MCP_SERVER_NAME || 'notefast'

  const server = new McpServer(
    {
      name: serverName,
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  registerMcpTools(server, notebookId)

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  })

  await server.connect(transport)

  return transport
}
