import { pgTable, uuid, varchar, boolean, timestamp, index } from 'drizzle-orm/pg-core';
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
    // Each user has exactly one default library; enforced at the application layer
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // List libraries owned by a user (most common access pattern)
    index('libraries_user_id_idx').on(table.userId),
  ],
);

export type Library = typeof libraries.$inferSelect;
export type NewLibrary = typeof libraries.$inferInsert;
