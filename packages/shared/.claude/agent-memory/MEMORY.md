# Database Agent Memory

## Key Patterns

### Drizzle Kit + ESM TypeScript Import Resolution
- This project uses `"type": "module"` and `moduleResolution: "bundler"` in tsconfig
- Drizzle-kit v0.30 uses esbuild-register internally (CJS) and cannot resolve `.js` imports to `.ts` files
- **Solution**: Use extensionless relative imports within schema files (e.g., `import { users } from './user'` not `'./user.js'`)
- `tsx` v4 runtime handles extensionless imports correctly at runtime
- TypeScript with `moduleResolution: "bundler"` allows extensionless relative imports
- See: `apps/backend/src/db/schema/*.ts`

### Schema File Conventions (confirmed)
- UUID PKs: `uuid('id').primaryKey().defaultRandom()`
- Timestamps: `timestamp('created_at', { withTimezone: true }).defaultNow().notNull()`
- Self-referential FK: `uuid('parent_collection_id').references((): AnyPgColumn => collections.id, { onDelete: 'set null' })`
- Every index has a comment explaining why it exists
- Type exports: `export type Model = typeof models.$inferSelect`

### Project File Paths
- Schema files: `apps/backend/src/db/schema/`
- Migrations: `apps/backend/src/db/migrations/`
- DB connection: `apps/backend/src/db/index.ts`
- Drizzle config: `apps/backend/drizzle.config.ts`
- Seed: `apps/backend/src/db/seed.ts`
- Migrate runner: `apps/backend/src/db/migrate.ts`

### Seed Data
- Default metadata fields: Tags (multi_enum, filterable, browsable), Artist (text, filterable, browsable), Year (number, filterable), NSFW (boolean, filterable), URL (url), Pre-supported (boolean, filterable)
- All default fields: isDefault=true, cannot be deleted via API
- Admin user: email from SEED_ADMIN_EMAIL env, password from SEED_ADMIN_PASSWORD env
- Seed uses `onConflictDoNothing` for idempotency
