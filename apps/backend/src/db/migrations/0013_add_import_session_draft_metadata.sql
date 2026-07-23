-- Persist user-reviewed metadata drafts on staged import sessions.
-- Nullable JSONB preserves existing sessions and allows a draft to be cleared;
-- request validation remains the application's source of truth for its shape.

ALTER TABLE "import_sessions" ADD COLUMN "draft_metadata" jsonb;
