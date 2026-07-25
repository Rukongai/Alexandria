import { pgTable, uuid, varchar, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { libraries } from './library.js';

// Library-scoped exact file hashes that the user has dismissed from duplicate review.
// ON DELETE CASCADE: deleting a library removes review decisions that have no scope.
export const duplicateFileIgnores = pgTable(
  'duplicate_file_ignores',
  {
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    // SHA-256 from model_files.hash.
    hash: varchar('hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One dismissal per exact file hash in a library; the leading library_id
    // also supports loading all dismissed file keys for one duplicate scan.
    primaryKey({ columns: [table.libraryId, table.hash] }),
  ],
);

export type DuplicateFileIgnore = typeof duplicateFileIgnores.$inferSelect;
export type NewDuplicateFileIgnore = typeof duplicateFileIgnores.$inferInsert;
