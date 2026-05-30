-- Add library_id to models and collections, backfill from each row's owner default library,
-- then flip to NOT NULL and wire up FKs + indexes.
--
-- Each step is split on a statement-breakpoint so a failure pinpoints the exact step.
-- ORDER MATTERS: the NOT NULL flips (steps 5-6) intentionally fail loudly if any backfill
-- (steps 3-4) missed a row. That fail-fast behavior is desired — there is no fallback.
-- This migration depends on 0006 having created exactly one default library per user.

-- Step 1: add nullable library_id to models.
ALTER TABLE "models" ADD COLUMN "library_id" uuid;--> statement-breakpoint
-- Step 2: add nullable library_id to collections.
ALTER TABLE "collections" ADD COLUMN "library_id" uuid;--> statement-breakpoint
-- Step 3: backfill models from the owning user's default library.
UPDATE "models" m
SET "library_id" = (
	SELECT l."id" FROM "libraries" l
	WHERE l."user_id" = m."user_id" AND l."is_default" = true
	LIMIT 1
)
WHERE m."library_id" IS NULL;--> statement-breakpoint
-- Step 4: backfill collections from the owning user's default library.
UPDATE "collections" c
SET "library_id" = (
	SELECT l."id" FROM "libraries" l
	WHERE l."user_id" = c."user_id" AND l."is_default" = true
	LIMIT 1
)
WHERE c."library_id" IS NULL;--> statement-breakpoint
-- Step 5: flip models.library_id to NOT NULL. Fails if step 3 left any NULL (intended).
ALTER TABLE "models" ALTER COLUMN "library_id" SET NOT NULL;--> statement-breakpoint
-- Step 6: flip collections.library_id to NOT NULL. Fails if step 4 left any NULL (intended).
ALTER TABLE "collections" ALTER COLUMN "library_id" SET NOT NULL;--> statement-breakpoint
-- Step 7: FK constraints. ON DELETE no action — libraries are not hard-deleted while they
-- own models/collections (restricted in the application layer).
ALTER TABLE "models" ADD CONSTRAINT "models_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Step 8: FK indexes for the primary library-browse query path.
CREATE INDEX "models_library_id_idx" ON "models" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "collections_library_id_idx" ON "collections" USING btree ("library_id");
