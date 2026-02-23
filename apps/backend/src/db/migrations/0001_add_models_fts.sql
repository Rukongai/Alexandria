-- Add full-text search support to the models table.
--
-- Strategy:
--   1. Add a tsvector column (search_vector) to store the pre-computed document vector.
--   2. Create a GIN index on that column for fast @@ queries.
--   3. Create a trigger function that rebuilds search_vector on every INSERT or UPDATE,
--      weighting name (A) more heavily than description (B).
--   4. Attach the trigger to the models table.
--   5. Backfill all existing rows so the index is immediately usable.

--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "search_vector" tsvector;
--> statement-breakpoint
-- GIN index is the standard choice for tsvector columns; supports @@ and @> operators
-- efficiently without sequential scan regardless of corpus size.
CREATE INDEX "models_search_vector_idx" ON "models" USING gin ("search_vector");
--> statement-breakpoint
-- Trigger function: rebuilds the tsvector from name (weight A) and description (weight B).
-- COALESCE guards against NULL description — an empty string produces no lexemes rather
-- than causing the whole expression to return NULL.
CREATE OR REPLACE FUNCTION models_search_vector_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Fire BEFORE INSERT OR UPDATE so search_vector is always current when the row lands.
-- Listing specific columns in the UPDATE OF clause avoids unnecessary trigger invocations
-- when unrelated columns (e.g. status, file_count) change — but we intentionally omit
-- that optimisation here because name/description changes are the common update path and
-- the overhead is negligible.
CREATE TRIGGER models_search_vector_trigger
BEFORE INSERT OR UPDATE ON "models"
FOR EACH ROW EXECUTE FUNCTION models_search_vector_update();
--> statement-breakpoint
-- Backfill all rows that existed before this migration.
UPDATE "models"
SET search_vector =
  setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(description, '')), 'B');
