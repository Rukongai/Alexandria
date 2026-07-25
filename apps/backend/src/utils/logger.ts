import pino from 'pino';
import { config } from '../config/index.js';

const options = {
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
};

// A stdio MCP server owns stdout for JSON-RPC messages. Route application
// diagnostics to stderr in that process so ordinary service logging cannot
// corrupt the protocol stream.
const rootLogger = process.env.ALEXANDRIA_MCP_STDIO === 'true'
  ? pino(options, pino.destination(2))
  : pino(options);

export function createLogger(service: string): pino.Logger {
  return rootLogger.child({ service });
}
