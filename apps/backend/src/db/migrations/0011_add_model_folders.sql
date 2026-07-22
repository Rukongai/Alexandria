CREATE TABLE "model_folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "model_id" uuid NOT NULL,
  "path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "model_folders"
  ADD CONSTRAINT "model_folders_model_id_models_id_fk"
  FOREIGN KEY ("model_id")
  REFERENCES "models"("id")
  ON DELETE CASCADE;

CREATE INDEX "model_folders_model_id_idx"
  ON "model_folders" ("model_id");

CREATE UNIQUE INDEX "model_folders_model_id_path_unique"
  ON "model_folders" ("model_id", "path");
