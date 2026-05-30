-- Backfill: ensure every EXISTING user has exactly one default library.
--
-- This must be idempotent — it runs on boot and may be re-applied. The WHERE NOT EXISTS
-- guard makes re-running a no-op once each user already owns a default library.
--
-- name:  the user's display_name + "'s Library" (e.g. "Ada's Library"); a sensible,
--        human-readable default that the user can rename later.
-- slug:  'library-' || the user's UUID with dashes stripped. This is deterministic and
--        globally unique (UUIDs are unique, one default library per user), satisfying the
--        UNIQUE(slug) constraint without collision risk across re-runs or users.
INSERT INTO "libraries" ("name", "slug", "user_id", "is_default")
SELECT
	u."display_name" || '''s Library',
	'library-' || replace(u."id"::text, '-', ''),
	u."id",
	true
FROM "users" u
WHERE NOT EXISTS (
	SELECT 1 FROM "libraries" l
	WHERE l."user_id" = u."id" AND l."is_default" = true
);
