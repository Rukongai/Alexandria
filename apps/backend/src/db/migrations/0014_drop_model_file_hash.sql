-- Drop models.file_hash. The column was documented as "SHA-256 hash of the
-- archive/source, for deduplication detection" but was never written by any
-- ingestion path, never read or queried, and never indexed — it advertised a
-- deduplication capability that does not exist.
--
-- An archive-level hash is also the wrong basis for dedup here: folder imports
-- have no archive at all, and re-compressing identical content yields a
-- different digest, so it cannot recognise the same model arriving from a
-- different source. If server-side deduplication is added later, the sound
-- basis is model_files.hash (per-file SHA-256, NOT NULL, populated on every
-- ingestion path), which is content-derived and recompression-proof.

ALTER TABLE "models" DROP COLUMN "file_hash";
