import { pgTable, uuid, varchar, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import type { AiChange } from '@alexandria/shared';
import { users } from './user.js';
import { libraries } from './library.js';

// AI change proposals — reviewable, expiring AI-suggested library mutations.
// ON DELETE CASCADE: deleting the owner or library removes proposals that cannot be applied.
export const aiChangeProposals = pgTable(
  'ai_change_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    summary: text('summary').notNull(),
    changes: jsonb('changes').$type<AiChange[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // List a user's proposals within a library, optionally narrowed by status.
    index('ai_change_proposals_user_library_status_idx').on(table.userId, table.libraryId, table.status),
    // Find expired proposals efficiently for expiry checks and future pruning.
    index('ai_change_proposals_expires_at_idx').on(table.expiresAt),
  ],
);

export type AiChangeProposal = typeof aiChangeProposals.$inferSelect;
export type NewAiChangeProposal = typeof aiChangeProposals.$inferInsert;
