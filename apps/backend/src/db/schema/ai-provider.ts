import { pgTable, uuid, varchar, text, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './user.js';

// AI providers — user-owned connection settings for AI assistant requests.
// ON DELETE CASCADE: removing a user removes their encrypted provider credentials.
export const aiProviders = pgTable(
  'ai_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    baseUrl: text('base_url').notNull(),
    // The API key is encrypted before persistence. The hint supports UI identification
    // without exposing the secret itself.
    apiKeyEncrypted: text('api_key_encrypted'),
    apiKeyHint: varchar('api_key_hint', { length: 32 }),
    model: varchar('model', { length: 255 }).notNull(),
    // At most one provider may be default for a user; enforced below.
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // List and resolve AI providers owned by a user.
    index('ai_providers_user_id_idx').on(table.userId),
    // Enforce one default AI provider per user while allowing any number of non-defaults.
    uniqueIndex('ai_providers_user_default_unique')
      .on(table.userId)
      .where(sql`${table.isDefault}`),
  ],
);

export type AiProvider = typeof aiProviders.$inferSelect;
export type NewAiProvider = typeof aiProviders.$inferInsert;
