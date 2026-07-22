import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { models } from './model.js';

// ModelFolders table — persisted virtual directories within a model.
// Files still live in model_files; this table lets empty folders survive refreshes.
export const modelFolders = pgTable(
  'model_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    // Slash-separated path relative to the model root, without leading/trailing slashes.
    path: text('path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('model_folders_model_id_idx').on(table.modelId),
    uniqueIndex('model_folders_model_id_path_unique').on(table.modelId, table.path),
  ],
);

export type ModelFolder = typeof modelFolders.$inferSelect;
export type NewModelFolder = typeof modelFolders.$inferInsert;
