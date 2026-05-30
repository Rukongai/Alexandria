import { pgTable, uuid, varchar, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import type { RuleNode } from '@alexandria/shared';
import { users } from './user.js';
import { libraries } from './library.js';

// Smart collections — dynamic, rule-based collections (P4).
// Unlike `collections` (manual membership via a join table), a smart collection
// stores only its rule tree in `definition`; the result set is derived on read
// by compiling that tree into a model query (see services/rule-engine.ts).
// There is no membership join table and no parent/child nesting — the rule tree
// provides all the structure.
export const smartCollections = pgTable(
  'smart_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    // URL-safe slug generated from name + random suffix
    slug: varchar('slug', { length: 255 }).notNull().unique(),
    description: text('description'),
    // The rule tree. Typed as RuleNode (the shared discriminated union) so reads
    // are typed without a cast; validated by the shared zod schema before write.
    definition: jsonb('definition').$type<RuleNode>().notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // Library this smart collection belongs to. NOT NULL — every smart
    // collection is scoped to a library, like manual collections.
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Lookup by slug for URL-based access
    index('smart_collections_slug_idx').on(table.slug),
    // List smart collections owned by a user
    index('smart_collections_user_id_idx').on(table.userId),
    // Filter smart collections belonging to a library (library browse query)
    index('smart_collections_library_id_idx').on(table.libraryId),
  ],
);

export type SmartCollection = typeof smartCollections.$inferSelect;
export type NewSmartCollection = typeof smartCollections.$inferInsert;
