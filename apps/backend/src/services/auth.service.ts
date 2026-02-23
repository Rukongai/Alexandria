import * as argon2 from 'argon2';
import type { UserProfile, UserRole } from '@alexandria/shared';
import { ErrorCodes } from '@alexandria/shared';
import { db } from '../db/index.js';
import { users } from '../db/schema/user.js';
import { eq } from 'drizzle-orm';
import { AppError } from '../utils/errors.js';
import { conflict, notFound, unauthorized } from '../utils/errors.js';

export interface AuthenticateResult {
  user: UserProfile;
}

export class AuthService {

  async createUser(
    email: string,
    password: string,
    displayName: string,
    role: UserRole = 'admin',
  ): Promise<UserProfile> {
    // Check for duplicate email
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (existing.length > 0) {
      throw conflict(`A user with email ${email} already exists`);
    }

    const passwordHash = await argon2.hash(password);

    const [created] = await db
      .insert(users)
      .values({
        email: email.toLowerCase(),
        displayName,
        passwordHash,
        role,
      })
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
      });

    if (!created) {
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 500, 'Failed to create user');
    }

    return {
      id: created.id,
      email: created.email,
      displayName: created.displayName,
      role: created.role as UserRole,
    };
  }

  async authenticate(email: string, password: string): Promise<AuthenticateResult> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (!user) {
      // Consistent timing — still hash to avoid user enumeration
      await argon2.hash(password);
      throw unauthorized('Invalid email or password');
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      throw unauthorized('Invalid email or password');
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role as UserRole,
      },
    };
  }

  async validateSession(sessionToken: string): Promise<UserProfile> {
    // The session token is the signed user ID from the cookie.
    // @fastify/cookie handles unsigning — by the time we receive it the value is the raw user ID.
    const userId = sessionToken;

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw unauthorized('Session is invalid or expired');
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role as UserRole,
    };
  }

  async updateProfile(
    userId: string,
    updates: {
      displayName?: string;
      email?: string;
      currentPassword?: string;
      newPassword?: string;
    },
  ): Promise<UserProfile> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw notFound(`User ${userId} not found`);
    }

    const patch: Partial<typeof users.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (updates.displayName !== undefined) {
      patch.displayName = updates.displayName;
    }

    if (updates.email !== undefined) {
      const emailLower = updates.email.toLowerCase();
      if (emailLower !== user.email) {
        const existing = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, emailLower))
          .limit(1);
        if (existing.length > 0) {
          throw conflict(`Email ${updates.email} is already in use`);
        }
        patch.email = emailLower;
      }
    }

    if (updates.newPassword !== undefined) {
      if (!updates.currentPassword) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          400,
          'Current password is required when setting a new password',
          'currentPassword',
        );
      }
      const valid = await argon2.verify(user.passwordHash, updates.currentPassword);
      if (!valid) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          400,
          'Current password is incorrect',
          'currentPassword',
        );
      }
      patch.passwordHash = await argon2.hash(updates.newPassword);
    }

    const [updated] = await db
      .update(users)
      .set(patch)
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
      });

    if (!updated) {
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 500, 'Failed to update profile');
    }

    return {
      id: updated.id,
      email: updated.email,
      displayName: updated.displayName,
      role: updated.role as UserRole,
    };
  }

  async getUserById(userId: string): Promise<UserProfile> {
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw notFound(`User ${userId} not found`);
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role as UserRole,
    };
  }

}
