import { pgTable, uuid, varchar, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { libraries } from './library.js';

// Library-scoped exact model fingerprints that the user has dismissed from duplicate review.
// ON DELETE CASCADE: deleting a library removes review decisions that have no scope.
export const duplicateModelIgnores = pgTable(
  'duplicate_model_ignores',
  {
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    // SHA-256 of the canonical complete sorted model-file hash multiset.
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One dismissal per exact model fingerprint in a library; the leading
    // library_id also supports loading all dismissed model keys for one scan.
    primaryKey({ columns: [table.libraryId, table.fingerprint] }),
  ],
);

export type DuplicateModelIgnore = typeof duplicateModelIgnores.$inferSelect;
export type NewDuplicateModelIgnore = typeof duplicateModelIgnores.$inferInsert;
