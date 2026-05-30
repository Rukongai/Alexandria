-- Add import_sessions table for staged archive upload workflow (scan → review → commit).
-- An import session is created when an archive is uploaded, tracks the scan and commit
-- lifecycle, and is deleted (or expired) once a model is committed or the session discarded.

CREATE TABLE "import_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "library_id" uuid NOT NULL,
  "original_filename" varchar(512) NOT NULL,
  "status" varchar(20) DEFAULT 'scanning' NOT NULL,
  "detected" jsonb,
  "manifest" jsonb,
  "staging_path" text,
  "model_id" uuid,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "import_sessions" ADD CONSTRAINT "import_sessions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sessions" ADD CONSTRAINT "import_sessions_library_id_libraries_id_fk"
  FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sessions" ADD CONSTRAINT "import_sessions_model_id_models_id_fk"
  FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_sessions_user_id_idx" ON "import_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "import_sessions_library_id_idx" ON "import_sessions" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "import_sessions_status_idx" ON "import_sessions" USING btree ("status");
