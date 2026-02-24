-- Add preview crop fields to models table
-- These store the CSS object-position values (0–100) for the cover image crop.
-- null = no crop set (defaults to center, i.e. 50% 50%)

ALTER TABLE models ADD COLUMN preview_crop_x REAL;
ALTER TABLE models ADD COLUMN preview_crop_y REAL;
