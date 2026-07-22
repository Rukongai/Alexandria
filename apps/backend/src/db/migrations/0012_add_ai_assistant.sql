-- Add persistence for user-owned AI provider settings and reviewable AI changes.
-- Provider secrets are encrypted by the application before storage; proposals are
-- library-scoped, expire automatically, and are removed with their owner or library.

CREATE TABLE "ai_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "base_url" text NOT NULL,
  "api_key_encrypted" text,
  "api_key_hint" varchar(32),
  "model" varchar(255) NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Deleting a user must remove encrypted credentials that no longer have an owner.
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- List providers and resolve a user's configured default.
CREATE INDEX "ai_providers_user_id_idx" ON "ai_providers" USING btree ("user_id");--> statement-breakpoint
-- A partial unique index permits many non-default providers but only one default per user.
CREATE UNIQUE INDEX "ai_providers_user_default_unique"
  ON "ai_providers" USING btree ("user_id") WHERE "is_default";--> statement-breakpoint

CREATE TABLE "ai_change_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "library_id" uuid NOT NULL,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "summary" text NOT NULL,
  "changes" jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "applied_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Proposals cannot outlive either their owner or the library they would mutate.
ALTER TABLE "ai_change_proposals" ADD CONSTRAINT "ai_change_proposals_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_change_proposals" ADD CONSTRAINT "ai_change_proposals_library_id_libraries_id_fk"
  FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Primary proposal-list query: one user's proposals in a library, optionally by status.
CREATE INDEX "ai_change_proposals_user_library_status_idx"
  ON "ai_change_proposals" USING btree ("user_id", "library_id", "status");--> statement-breakpoint
-- Supports efficient expiry queries and future pruning of elapsed proposals.
CREATE INDEX "ai_change_proposals_expires_at_idx"
  ON "ai_change_proposals" USING btree ("expires_at");
