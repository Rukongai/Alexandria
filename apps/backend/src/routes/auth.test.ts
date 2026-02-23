import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { users } from '../db/schema/user.js';
import * as schema from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------
// Integration tests run against a real Postgres database (the test DB spun
// up from Docker Compose).  We use a separate database URL so the dev
// database is never touched.  Between tests we delete the users inserted by
// each test so that tests don't share state.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://alexandria:alexandria@localhost:5433/alexandria_test';

const { Pool } = pg;
const testPool = new Pool({ connectionString: TEST_DATABASE_URL });
const testDb = drizzle(testPool, { schema });

let app: FastifyInstance;

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

async function createTestUser(opts: {
  email: string;
  password: string;
  displayName?: string;
}): Promise<void> {
  // Use the app's AuthService so the password is hashed correctly.
  const authService = (app as FastifyInstance & { authService: import('../services/auth.service.js').AuthService }).authService;
  await authService.createUser(
    opts.email,
    opts.password,
    opts.displayName ?? 'Test User',
  );
}

async function deleteUserByEmail(email: string): Promise<void> {
  await testDb.delete(users).where(eq(users.email, email.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Point the app at the test database
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testPool.end();
});

beforeEach(async () => {
  // Start each test with a clean slate — remove any leftover test users
  await testDb
    .delete(users)
    .where(eq(users.email, 'test@example.com'));
  await testDb
    .delete(users)
    .where(eq(users.email, 'updated@example.com'));
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

describe('POST /auth/login', () => {
  it('should return a UserProfile in the data envelope when credentials are valid', async () => {
    await createTestUser({ email: 'test@example.com', password: 'password123' });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'password123' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Envelope structure
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta', null);
    expect(body).toHaveProperty('errors', null);

    // UserProfile shape
    expect(body.data).toMatchObject({
      email: 'test@example.com',
      displayName: 'Test User',
      role: 'admin',
    });
    expect(typeof body.data.id).toBe('string');
    // passwordHash must NOT be exposed
    expect(body.data).not.toHaveProperty('passwordHash');
  });

  it('should set a session cookie when credentials are valid', async () => {
    await createTestUser({ email: 'test@example.com', password: 'password123' });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'password123' },
    });

    expect(response.statusCode).toBe(200);
    const setCookieHeader = response.headers['set-cookie'];
    expect(setCookieHeader).toBeDefined();
    const cookieString = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : String(setCookieHeader);
    expect(cookieString).toContain('alexandria_session');
  });

  it('should return UNAUTHORIZED error when password is wrong', async () => {
    await createTestUser({ email: 'test@example.com', password: 'password123' });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'wrongpassword' },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.data).toBeNull();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].code).toBe('UNAUTHORIZED');
  });

  it('should return UNAUTHORIZED error when email does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: 'password123' },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.errors[0].code).toBe('UNAUTHORIZED');
  });

  it('should return VALIDATION_ERROR when email is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: 'password123' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.data).toBeNull();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('should return VALIDATION_ERROR when password is too short', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'short' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('should return VALIDATION_ERROR when email format is invalid', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'not-an-email', password: 'password123' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------

describe('GET /auth/me', () => {
  it('should return the current user profile when a valid session cookie is present', async () => {
    await createTestUser({ email: 'test@example.com', password: 'password123' });

    // Log in to get a session cookie
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'password123' },
    });

    const setCookieHeader = loginResponse.headers['set-cookie'];
    const cookieString = Array.isArray(setCookieHeader) ? setCookieHeader[0] : String(setCookieHeader);
    // Extract just the cookie value (before the first ';')
    const cookie = cookieString.split(';')[0];

    const meResponse = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie },
    });

    expect(meResponse.statusCode).toBe(200);
    const body = meResponse.json();
    expect(body.data).toMatchObject({ email: 'test@example.com' });
    expect(body.meta).toBeNull();
    expect(body.errors).toBeNull();
  });

  it('should return UNAUTHORIZED when no session cookie is present', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.data).toBeNull();
    expect(body.errors[0].code).toBe('UNAUTHORIZED');
  });

  it('should return UNAUTHORIZED when session cookie is tampered with', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: 'alexandria_session=tampered-value' },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.errors[0].code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

describe('POST /auth/logout', () => {
  it('should return 200 with null data and clear the session cookie', async () => {
    await createTestUser({ email: 'test@example.com', password: 'password123' });

    // Log in first
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'password123' },
    });
    const setCookieHeader = loginResponse.headers['set-cookie'];
    const cookieString = Array.isArray(setCookieHeader) ? setCookieHeader[0] : String(setCookieHeader);
    const cookie = cookieString.split(';')[0];

    // Logout
    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });

    expect(logoutResponse.statusCode).toBe(200);
    const body = logoutResponse.json();
    expect(body.data).toBeNull();
    expect(body.meta).toBeNull();
    expect(body.errors).toBeNull();

    // The session cookie should be cleared (Max-Age=0 or Expires in the past)
    const logoutCookie = logoutResponse.headers['set-cookie'];
    const logoutCookieString = Array.isArray(logoutCookie) ? logoutCookie.join('; ') : String(logoutCookie ?? '');
    // @fastify/cookie clearCookie sets Max-Age=0
    expect(logoutCookieString).toMatch(/alexandria_session=;|Max-Age=0/i);
  });

  it('should return 200 even when called without a session cookie', async () => {
    // Logout is idempotent — no session required
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
    });

    expect(response.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH /auth/me
// ---------------------------------------------------------------------------

describe('PATCH /auth/me', () => {
  async function loginAndGetCookie(): Promise<string> {
    await deleteUserByEmail('test@example.com');
    await createTestUser({ email: 'test@example.com', password: 'password123' });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'password123' },
    });
    const setCookieHeader = loginResponse.headers['set-cookie'];
    const cookieString = Array.isArray(setCookieHeader) ? setCookieHeader[0] : String(setCookieHeader);
    return cookieString.split(';')[0];
  }

  it('should update displayName and return the updated UserProfile', async () => {
    const cookie = await loginAndGetCookie();

    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: { cookie },
      payload: { displayName: 'Updated Name' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.displayName).toBe('Updated Name');
    expect(body.meta).toBeNull();
    expect(body.errors).toBeNull();
  });

  it('should update the password when currentPassword is correct', async () => {
    const cookie = await loginAndGetCookie();

    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: { cookie },
      payload: {
        currentPassword: 'password123',
        newPassword: 'newpassword456',
      },
    });

    expect(response.statusCode).toBe(200);

    // Verify the new password works
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'newpassword456' },
    });
    expect(loginResponse.statusCode).toBe(200);
  });

  it('should return VALIDATION_ERROR when newPassword is supplied without currentPassword', async () => {
    const cookie = await loginAndGetCookie();

    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: { cookie },
      payload: { newPassword: 'newpassword456' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('should return UNAUTHORIZED when no session cookie is present', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      payload: { displayName: 'Hacker' },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.errors[0].code).toBe('UNAUTHORIZED');
  });

  it('should return VALIDATION_ERROR when currentPassword is wrong', async () => {
    const cookie = await loginAndGetCookie();

    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: { cookie },
      payload: {
        currentPassword: 'wrongpassword',
        newPassword: 'newpassword456',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('should return CONFLICT when updating email to one that is already in use', async () => {
    const cookie = await loginAndGetCookie();

    // Create a second user with a different email
    await deleteUserByEmail('other@example.com');
    await createTestUser({ email: 'other@example.com', password: 'password123' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: { cookie },
      payload: { email: 'other@example.com' },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.errors[0].code).toBe('CONFLICT');

    // Cleanup second user
    await deleteUserByEmail('other@example.com');
  });
});

// ---------------------------------------------------------------------------
// Envelope shape contract
// ---------------------------------------------------------------------------

describe('API envelope format', () => {
  it('should always include data, meta, and errors keys on a success response', async () => {
    await createTestUser({ email: 'test@example.com', password: 'password123' });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'password123' },
    });

    const body = response.json();
    expect(Object.keys(body)).toContain('data');
    expect(Object.keys(body)).toContain('meta');
    expect(Object.keys(body)).toContain('errors');
  });

  it('should always include data, meta, and errors keys on an error response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'bad', password: 'x' },
    });

    const body = response.json();
    expect(Object.keys(body)).toContain('data');
    expect(Object.keys(body)).toContain('meta');
    expect(Object.keys(body)).toContain('errors');
    expect(body.data).toBeNull();
  });
});
