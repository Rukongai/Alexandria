-- Add a palette-accent color to libraries (P5 multi-library).
-- Rendered to a gradient badge on the All-Libraries cards and the rail switcher.
-- Defaulted to 'amber' and NOT NULL, so existing rows backfill automatically with
-- no separate data-migration step (mirrors the single original library's identity).

ALTER TABLE "libraries" ADD COLUMN "color" varchar(32) DEFAULT 'amber' NOT NULL;
