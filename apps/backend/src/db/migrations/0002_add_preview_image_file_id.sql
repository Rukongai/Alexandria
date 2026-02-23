-- Add user-selectable cover image column to the models table.
--
-- preview_image_file_id stores the model_files(id) of the image the user
-- has chosen as the library card cover. When NULL the frontend falls back
-- to the first image file found in the model.
--
-- ON DELETE SET NULL: removing a model file that was pinned as the preview
-- automatically reverts the model to the fallback behaviour without any
-- application-layer cleanup job.

--> statement-breakpoint
ALTER TABLE "models"
  ADD COLUMN "preview_image_file_id" uuid
  REFERENCES "model_files"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- FK index: PostgreSQL does not create indexes on FK columns automatically.
-- This index is used when ON DELETE SET NULL fires (Postgres must locate every
-- models row that references the deleted model_files row) and also supports
-- any future query that joins or filters on preview_image_file_id.
CREATE INDEX "models_preview_image_file_id_idx"
  ON "models" ("preview_image_file_id");
