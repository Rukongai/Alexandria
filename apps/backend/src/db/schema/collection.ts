import { pgTable, uuid, varchar, text, timestamp, primaryKey, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { users } from './user.js';
import { models } from './model.js';

// Collections table — hierarchical organizational structure for models (per D8).
// Collections are not metadata — they represent "where you put a model", not "what it is".
// ON DELETE SET NULL for parentCollectionId: deleting a parent makes children top-level.
export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    // URL-safe slug generated from name + random suffix
    slug: varchar('slug', { length: 255 }).notNull().unique(),
    description: text('description'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // Self-referential FK for tree structure; SET NULL instead of CASCADE
    // so child collections survive parent deletion (become top-level)
    parentCollectionId: uuid('parent_collection_id').references(
      (): AnyPgColumn => collections.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Lookup by slug for URL-based access
    index('collections_slug_idx').on(table.slug),
    // List collections owned by a user
    index('collections_user_id_idx').on(table.userId),
    // Traverse the collection tree: find children of a parent
    index('collections_parent_collection_id_idx').on(table.parentCollectionId),
  ],
);

// CollectionModels join table — many-to-many between collections and models.
// A model can belong to multiple collections.
// ON DELETE CASCADE on both sides: removing a collection or model cleans up membership.
export const collectionModels = pgTable(
  'collection_models',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
  },
  (table) => [
    // Composite primary key prevents duplicate memberships
    primaryKey({ columns: [table.collectionId, table.modelId] }),
    // Find all models in a collection (GET /collections/:id/models)
    index('collection_models_collection_id_idx').on(table.collectionId),
    // Find all collections a model belongs to (model detail page)
    index('collection_models_model_id_idx').on(table.modelId),
  ],
);

export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type CollectionModel = typeof collectionModels.$inferSelect;
export type NewCollectionModel = typeof collectionModels.$inferInsert;
