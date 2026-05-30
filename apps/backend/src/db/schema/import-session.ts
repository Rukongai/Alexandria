import { pgTable, uuid, varchar, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import type { DetectedImportMetadata } from '@alexandria/shared';
import { users } from './user.js';
import { libraries } from './library.js';
import { models } from './model.js';

/**
 * A staged archive upload awaiting review/commit.
 *
 * An uploaded archive is scanned (extracted + inspected) into a `staging_path`
 * without being committed. The detected metadata + file manifest are persisted
 * here so the user can review/edit before committing the session into a model.
 * Abandoned sessions are reaped via `expires_at`.
 */
export const importSessions = pgTable(
  'import_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    originalFilename: varchar('original_filename', { length: 512 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('scanning'),
    // Best-effort metadata detected during scan.
    detected: jsonb('detected').$type<DetectedImportMetadata>(),
    // The file manifest captured at scan, reused at commit (FileManifest shape).
    manifest: jsonb('manifest').$type<unknown>(),
    // Directory of extracted files kept between scan and commit.
    stagingPath: text('staging_path'),
    modelId: uuid('model_id').references(() => models.id, { onDelete: 'set null' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    index('import_sessions_user_id_idx').on(table.userId),
    index('import_sessions_library_id_idx').on(table.libraryId),
    index('import_sessions_status_idx').on(table.status),
  ],
);
