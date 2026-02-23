import pino from 'pino';
import { config } from '../config/index.js';

const rootLogger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
});

export function createLogger(service: string): pino.Logger {
  return rootLogger.child({ service });
}
