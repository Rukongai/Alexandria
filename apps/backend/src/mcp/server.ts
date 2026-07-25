import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// This marker must be set before importing any Alexandria module. The shared
// logger uses it to keep log output on stderr and stdout clean for JSON-RPC.
process.env.ALEXANDRIA_MCP_STDIO = 'true';

if (!process.env.DATABASE_URL?.trim()) {
  const user = process.env.POSTGRES_USER?.trim() || 'alexandria';
  const password = process.env.POSTGRES_PASSWORD?.trim() || 'alexandria';
  const port = process.env.POSTGRES_PORT?.trim() || '5433';
  const database = process.env.POSTGRES_DB?.trim() || 'alexandria';
  process.env.DATABASE_URL = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${port}/${encodeURIComponent(database)}`;
}

async function main(): Promise<void> {
  const { pool } = await import('../db/index.js');
  let server: McpServer;
  try {
    const { createAlexandriaMcpServer, mcpScopeOptionsFromEnvironment } =
      await import('./tools.js');
    server = await createAlexandriaMcpServer(mcpScopeOptionsFromEnvironment());
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  const transport = new StdioServerTransport();
  let closing = false;

  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.stdin.once('end', () => void shutdown());

  try {
    await server.connect(transport);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    service: 'McpServer',
    level: 'error',
    message: error instanceof Error ? error.message : 'MCP server failed',
  })}\n`);
  process.exitCode = 1;
});
