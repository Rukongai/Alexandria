import { pgTable, uuid, varchar, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './user.js';

// Libraries table — top-level organizational scope for models and collections.
// Each user owns one or more libraries; one is marked as default.
// ON DELETE: Library deletion is restricted at the application layer (libraries own models).
export const libraries = pgTable(
  'libraries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    // URL-safe slug generated from name + random suffix
    slug: varchar('slug', { length: 255 }).notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // Each user has exactly one default library; enforced by a partial unique index below.
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // List libraries owned by a user (most common access pattern)
    index('libraries_user_id_idx').on(table.userId),
    // Enforce exactly one default library per user at the DB level. A partial
    // unique index lets a user have many non-default libraries but only one
    // default, and makes resolveDefaultLibraryId's lookup race-safe.
    uniqueIndex('libraries_user_default_unique')
      .on(table.userId)
      .where(sql`${table.isDefault}`),
  ],
);

export type Library = typeof libraries.$inferSelect;
export type NewLibrary = typeof libraries.$inferInsert;
