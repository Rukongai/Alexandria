-- Add preview crop scale to models table.
-- Stores zoom level relative to the object-fit:cover baseline.
-- 1.0 = no extra zoom (card shows same region as object-fit:cover would).
-- > 1.0 = zoomed in further (smaller crop window).
-- null = no crop set (treated as 1.0 at render time).

ALTER TABLE models ADD COLUMN preview_crop_scale REAL;
