-- Add libraries table and associate models with libraries (issue #42).
--
-- Libraries are admin-managed storage locations. Each library defines a root
-- filesystem path and a path_template string that controls how models are laid
-- out on disk within that root (e.g. "{artist}/{year}/{name}").
--
-- Libraries are NOT user-owned — they are shared across the system and
-- administered by site admins.
--
-- models.library_id is nullable: existing models pre-date the library system
-- and have no library assignment. Making it non-nullable here would break every
-- existing row. Non-nullable enforcement (if ever required) belongs in a future
-- migration once all models have been assigned.
--
-- ON DELETE SET NULL on models.library_id: deleting a library orphans its
-- models (library_id → NULL) rather than cascading a delete to potentially
-- thousands of model records.

--> statement-breakpoint
CREATE TABLE "libraries" (
  "id"            uuid         NOT NULL DEFAULT gen_random_uuid(),
  "name"          TEXT         NOT NULL UNIQUE,
  "slug"          TEXT         NOT NULL,
  "root_path"     text         NOT NULL,
  "path_template" text         NOT NULL,
  "created_at"    timestamptz  NOT NULL DEFAULT now(),
  "updated_at"    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "libraries_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- Lookup libraries by name (admin UI search)
CREATE INDEX "libraries_name_idx" ON "libraries" ("name");
--> statement-breakpoint
-- Unique index on slug for fast slug resolution
CREATE UNIQUE INDEX "libraries_slug_idx" ON "libraries" ("slug");

--> statement-breakpoint
ALTER TABLE "models"
  ADD COLUMN "library_id" uuid
  REFERENCES "libraries"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- FK index: PostgreSQL does not auto-create indexes on FK columns.
-- Used for listing all models in a library (browse view) and for the
-- ON DELETE SET NULL scan that clears library_id when a library is removed.
CREATE INDEX "models_library_id_idx" ON "models" ("library_id");
