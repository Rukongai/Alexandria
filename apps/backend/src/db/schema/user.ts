import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';

// Users table — represents authenticated accounts.
// MVP is single-admin but the schema supports multiple users with roles.
// ON DELETE: User deletion is restricted at the application layer (users own models).
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    // UserRole: 'admin' | 'user'
    role: varchar('role', { length: 20 }).notNull().default('admin'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Fast lookup for login by email (most common auth query)
    index('users_email_idx').on(table.email),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
