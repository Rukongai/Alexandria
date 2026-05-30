-- Add the libraries table — the top-level organizational scope for models and collections.
-- Each user owns one or more libraries; exactly one is marked is_default (enforced in the
-- application layer). This is the first of three migrations (0005 -> 0006 -> 0007) that
-- introduce libraries onto a populated production database; they MUST run in sequence.
--
-- Mirrors src/db/schema/library.ts exactly: uuid PK (gen_random_uuid), name, unique slug,
-- user_id FK NOT NULL -> users(id), is_default bool default false, created/updated timestamptz.
CREATE TABLE "libraries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"user_id" uuid NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "libraries_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
-- FK to users. ON DELETE no action: library deletion is restricted at the application layer
-- because libraries own models/collections; users are not hard-deleted out from under them.
ALTER TABLE "libraries" ADD CONSTRAINT "libraries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- List libraries owned by a user (most common access pattern).
CREATE INDEX "libraries_user_id_idx" ON "libraries" USING btree ("user_id");
