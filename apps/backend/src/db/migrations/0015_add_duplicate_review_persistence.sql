-- Persist duplicate-review state. The boolean flags are maintained by the
-- reconciliation service; defaults keep existing models and files non-duplicate
-- until that service evaluates them. Ignore keys are scoped to a library so an
-- identical hash or fingerprint can be dismissed independently in each library.

ALTER TABLE "models"
  ADD COLUMN "is_duplicate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_files"
  ADD COLUMN "is_duplicate" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE TABLE "duplicate_file_ignores" (
  "library_id" uuid NOT NULL,
  "hash" varchar(64) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "duplicate_file_ignores_library_id_hash_pk"
    PRIMARY KEY ("library_id", "hash")
);--> statement-breakpoint
-- ON DELETE CASCADE: ignore decisions cannot outlive their library scope.
ALTER TABLE "duplicate_file_ignores"
  ADD CONSTRAINT "duplicate_file_ignores_library_id_libraries_id_fk"
  FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "duplicate_model_ignores" (
  "library_id" uuid NOT NULL,
  "fingerprint" varchar(64) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "duplicate_model_ignores_library_id_fingerprint_pk"
    PRIMARY KEY ("library_id", "fingerprint")
);--> statement-breakpoint
-- ON DELETE CASCADE: ignore decisions cannot outlive their library scope.
ALTER TABLE "duplicate_model_ignores"
  ADD CONSTRAINT "duplicate_model_ignores_library_id_libraries_id_fk"
  FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id")
  ON DELETE cascade ON UPDATE no action;
