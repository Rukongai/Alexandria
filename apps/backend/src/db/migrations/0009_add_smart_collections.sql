-- Add smart_collections table for dynamic, rule-based collections (P4).
-- A smart collection stores only its rule tree in `definition` (jsonb); the
-- result set is derived on read by compiling the tree into a model query.
-- No membership join table and no parent_collection_id — the rule tree is the
-- structure. FK onDelete mirrors `collections` (no action) for consistency.

CREATE TABLE "smart_collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(255) NOT NULL,
  "slug" varchar(255) NOT NULL,
  "description" text,
  "definition" jsonb NOT NULL,
  "user_id" uuid NOT NULL,
  "library_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "smart_collections_slug_unique" UNIQUE("slug")
);--> statement-breakpoint
ALTER TABLE "smart_collections" ADD CONSTRAINT "smart_collections_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_collections" ADD CONSTRAINT "smart_collections_library_id_libraries_id_fk"
  FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "smart_collections_slug_idx" ON "smart_collections" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "smart_collections_user_id_idx" ON "smart_collections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "smart_collections_library_id_idx" ON "smart_collections" USING btree ("library_id");
