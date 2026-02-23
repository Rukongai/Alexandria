import { pgTable, uuid, varchar, text, bigint, timestamp, index } from 'drizzle-orm/pg-core';
import { models } from './model';

// ModelFiles table — individual files belonging to a model.
// ON DELETE CASCADE: When a model is deleted, all its files are deleted automatically.
export const modelFiles = pgTable(
  'model_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    filename: varchar('filename', { length: 500 }).notNull(),
    // Relative path within the original zip/folder structure, preserved as-is
    relativePath: text('relative_path').notNull(),
    // FileType: 'stl' | 'image' | 'document' | 'other'
    fileType: varchar('file_type', { length: 20 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    // bigint for individual file sizes
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    // Path in managed storage: <storage_root>/models/<model_id>/<relative_path>
    storagePath: text('storage_path').notNull(),
    // SHA-256 hash computed at import time (per D7)
    hash: varchar('hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Primary access pattern: list all files for a model
    index('model_files_model_id_idx').on(table.modelId),
    // Filter files by type (e.g., get all images for thumbnail generation)
    index('model_files_file_type_idx').on(table.fileType),
    // Filter by type within a model (SearchService: fileType filter)
    index('model_files_model_id_file_type_idx').on(table.modelId, table.fileType),
  ],
);

export type ModelFile = typeof modelFiles.$inferSelect;
export type NewModelFile = typeof modelFiles.$inferInsert;
