-- Keep the reviewed file layout separate from draft_metadata. An explicit
-- metadata form submission replaces the metadata request source at commit and
-- must not accidentally discard an assistant-reviewed organization plan.
ALTER TABLE "import_sessions" ADD COLUMN "draft_file_layout" jsonb;
