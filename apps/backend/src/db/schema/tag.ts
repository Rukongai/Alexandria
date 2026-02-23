import { pgTable, uuid, varchar, primaryKey, index } from 'drizzle-orm/pg-core';
import { models } from './model';

// Tags table — optimized storage for multi_enum metadata (per D3).
// Tags are conceptually just another metadata field at the API level.
// MetadataService routes tag operations here instead of model_metadata for join performance.
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull().unique(),
    // URL-safe slug for filtering: GET /models?tags=dragon,fantasy
    slug: varchar('slug', { length: 255 }).notNull().unique(),
  },
  (table) => [
    // Lookup by slug for search filter queries (most common tag access pattern)
    index('tags_slug_idx').on(table.slug),
    // Lookup by name for tag creation deduplication
    index('tags_name_idx').on(table.name),
  ],
);

// ModelTags join table — many-to-many between models and tags.
// Composite primary key prevents duplicate associations.
// ON DELETE CASCADE on both sides: removing a model or tag cleans up associations.
export const modelTags = pgTable(
  'model_tags',
  {
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [
    // Composite primary key enforces unique model-tag pairs
    primaryKey({ columns: [table.modelId, table.tagId] }),
    // Find all tags for a model (MetadataService: load model tags)
    index('model_tags_model_id_idx').on(table.modelId),
    // Find all models with a tag (SearchService: tag-based filtering)
    index('model_tags_tag_id_idx').on(table.tagId),
  ],
);

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type ModelTag = typeof modelTags.$inferSelect;
export type NewModelTag = typeof modelTags.$inferInsert;
