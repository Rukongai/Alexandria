import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../db/index.js';
import { libraries, users } from '../db/schema/index.js';

describe('MCP stdio launcher', () => {
  it('does not emit npm lifecycle text on protocol stdout', async () => {
    const unique = randomUUID().replaceAll('-', '');
    const [user] = await db.insert(users).values({
      email: `mcp-stdio-${unique}@example.com`,
      displayName: 'MCP stdio test',
      passwordHash: 'not-used-by-this-test',
      role: 'user',
    }).returning({ id: users.id });
    const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
    const child = spawn('npm', ['--silent', 'run', 'mcp'], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ALEXANDRIA_MCP_USER_ID: user.id,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

    try {
      expect(exitCode, stderr).toBe(0);
      expect(stdout).toBe('');
    } finally {
      await db.delete(libraries).where(eq(libraries.userId, user.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });
});
