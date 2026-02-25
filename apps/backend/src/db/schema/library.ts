import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// Libraries table — admin-managed storage locations. A library defines where
// models are stored on disk and how their paths are structured via a template.
// Libraries are NOT user-owned; they are configured by administrators and shared
// across all users in the system.
export const libraries = pgTable(
  'libraries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Human-readable display name for the library (e.g., "Main Library")
    name: text('name').notNull().unique(),
    // URL-safe slug for the library (e.g., "main-library-a1b2")
    slug: text('slug').notNull().unique(),
    // Absolute filesystem path to the library's root storage directory
    rootPath: text('root_path').notNull(),
    // Template string controlling how models are laid out within rootPath
    // (e.g., "{artist}/{year}/{name}" — same syntax as the folder import pattern)
    pathTemplate: text('path_template').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Lookup libraries by name (admin UI search)
    index('libraries_name_idx').on(table.name),
    // Unique index on slug for fast slug resolution
    uniqueIndex('libraries_slug_idx').on(table.slug),
  ],
);

export type LibraryRow = typeof libraries.$inferSelect;
export type NewLibraryRow = typeof libraries.$inferInsert;
