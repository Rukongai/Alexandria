import { pgTable, uuid, varchar, text, bigint, integer, real, timestamp, index, customType } from 'drizzle-orm/pg-core';
import { users } from './user.js';

// Custom tsvector type — Drizzle does not ship a native tsvector column type.
// This is a thin wrapper that maps the column to PostgreSQL's tsvector type.
// The column value is managed exclusively by the models_search_vector_update trigger;
// application code should never write to it directly.
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// Models table — the central entity. Each model represents one 3D printing model
// (a single archive upload or folder import).
// ON DELETE: Deleting a user does not cascade to models — models are orphaned first
// in the application layer, or deletion is blocked.
export const models = pgTable(
  'models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    // Unique slug generated from name + random suffix (e.g., dragon-bust-a3f2)
    slug: varchar('slug', { length: 255 }).notNull().unique(),
    description: text('description'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // ModelSourceType: 'zip_upload' | 'archive_upload' | 'folder_import' | 'manual'
    sourceType: varchar('source_type', { length: 20 }).notNull(),
    // ModelStatus: 'processing' | 'ready' | 'error'
    status: varchar('status', { length: 20 }).notNull().default('processing'),
    originalFilename: varchar('original_filename', { length: 500 }),
    // bigint for file sizes that may exceed 2GB
    totalSizeBytes: bigint('total_size_bytes', { mode: 'number' }).notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    // SHA-256 hash of the archive/source, for deduplication detection
    fileHash: varchar('file_hash', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Populated and maintained by the models_search_vector_update trigger.
    // name is weighted A (most relevant), description is weighted B.
    // Never set this column from application code.
    searchVector: tsvector('search_vector'),
    // User-selected cover image for library cards. Nullable — when null, the system
    // falls back to the first image file in the model.
    // References model_files(id) ON DELETE SET NULL — enforced in SQL migration.
    // Note: Drizzle-level .references() is omitted here to avoid the circular import
    // between model.ts and model-file.ts; the FK constraint lives in the migration SQL.
    previewImageFileId: uuid('preview_image_file_id'),
    // CSS object-position crop values (0–100). null = no crop set (browser defaults to 50% 50%).
    // Applied via object-position on the card thumbnail image.
    previewCropX: real('preview_crop_x'),
    previewCropY: real('preview_crop_y'),
    // Zoom multiplier applied on top of object-fit:cover (1.0 = no extra zoom, >1.0 = zoom in).
    // Applied via transform: scale() on the card thumbnail image.
    previewCropScale: real('preview_crop_scale'),
  },
  (table) => [
    // Fast lookup by slug for URL-based access
    index('models_slug_idx').on(table.slug),
    // Filter models by owner (user's model library view)
    index('models_user_id_idx').on(table.userId),
    // Filter by processing status (job status polling, admin views)
    index('models_status_idx').on(table.status),
    // Sort by creation date (default browse order)
    index('models_created_at_idx').on(table.createdAt),
    // GIN index required for efficient tsvector @@ tsquery full-text search
    index('models_search_vector_idx').using('gin', table.searchVector),
    // FK index: resolve which model owns a preview image file (ON DELETE SET NULL lookup)
    index('models_preview_image_file_id_idx').on(table.previewImageFileId),
  ],
);

export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;
