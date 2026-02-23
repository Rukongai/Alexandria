import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { models } from './model';

// MetadataFieldDefinitions table — configurable field schema for model metadata.
// Default fields (isDefault: true) are seeded and cannot be deleted.
// Tags is handled specially (routed to model_tags), but its definition lives here.
export const metadataFieldDefinitions = pgTable(
  'metadata_field_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    // URL-safe identifier used in API queries and metadata routing
    slug: varchar('slug', { length: 255 }).notNull().unique(),
    // MetadataFieldType: 'text' | 'number' | 'boolean' | 'date' | 'url' | 'enum' | 'multi_enum'
    type: varchar('type', { length: 20 }).notNull(),
    // Default fields cannot be deleted (Tags, Artist, Year, NSFW, URL, Pre-supported)
    isDefault: boolean('is_default').notNull().default(false),
    // Filterable fields appear in search filter UI
    isFilterable: boolean('is_filterable').notNull().default(false),
    // Browsable fields appear in browse-by UI (select a value, see matching models)
    isBrowsable: boolean('is_browsable').notNull().default(false),
    // Optional configuration: enumOptions, validationPattern, displayHint
    config: jsonb('config'),
    // Controls display order in UI
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Lookup by slug in API requests and MetadataService routing
    index('metadata_field_definitions_slug_idx').on(table.slug),
    // Filter to default-only or custom-only fields
    index('metadata_field_definitions_is_default_idx').on(table.isDefault),
    // Ordered field list for UI rendering
    index('metadata_field_definitions_sort_order_idx').on(table.sortOrder),
  ],
);

// ModelMetadata table — generic key-value metadata storage for non-tag fields.
// Tags use the model_tags join table for performance. All other metadata lives here.
// ON DELETE CASCADE: When a model or field definition is deleted, its values are deleted.
export const modelMetadata = pgTable(
  'model_metadata',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    fieldDefinitionId: uuid('field_definition_id')
      .notNull()
      .references(() => metadataFieldDefinitions.id, { onDelete: 'cascade' }),
    // All values stored as text; parsed by MetadataService according to field type
    value: text('value').notNull(),
  },
  (table) => [
    // Enforce one value per field per model (upsert pattern in MetadataService)
    unique('model_metadata_model_field_unique').on(table.modelId, table.fieldDefinitionId),
    // Fetch all metadata for a model (model detail page)
    index('model_metadata_model_id_idx').on(table.modelId),
    // Filter models by a specific field value (SearchService metadata filtering)
    index('model_metadata_field_definition_id_idx').on(table.fieldDefinitionId),
    // Composite index for the combined metadata filter pattern used in SearchService
    index('model_metadata_model_id_field_id_idx').on(table.modelId, table.fieldDefinitionId),
  ],
);

export type MetadataFieldDefinition = typeof metadataFieldDefinitions.$inferSelect;
export type NewMetadataFieldDefinition = typeof metadataFieldDefinitions.$inferInsert;
export type ModelMetadata = typeof modelMetadata.$inferSelect;
export type NewModelMetadata = typeof modelMetadata.$inferInsert;
