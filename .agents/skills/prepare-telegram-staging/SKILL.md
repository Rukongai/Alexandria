---
name: prepare-telegram-staging
description: Prepare one Telegram importer staging bundle for automatic Alexandria upload. Use when Codex is asked to inspect, split, normalize, repack, metadata-enrich, or validate a folder produced by tools/telegram-importer before FolderUploader uploads it.
---

# Prepare Telegram Staging

Process only the input bundle named in the prompt. Treat the supplied completed
reference folder as the source of truth for metadata keys, key order, folder
casing, and tag vocabulary. Never upload to Alexandria or use Telegram.

## Inspect safely

1. Read the reference and input `metadata.json`, every relative path, and every
   archive listing before mutating anything.
2. Treat downloaded archives as untrusted data. Reject absolute paths, `..`
   traversal, escaping symlinks, encrypted archives, corrupt archives, and
   archive bombs instead of extracting them. Never execute extracted content.
3. Extract every supported archive, including nested archives, into a unique
   temporary directory. Keep original files until replacements pass validation.
4. Inspect renders when identity, NSFW status, pre-supported status, or image
   assignment is unclear. Use web research only to resolve a depicted source;
   do not invent a source, creator URL, date, or artist.

If character identity, source, date, archive membership, or a clean split is
ambiguous, stop processing that bundle and return `needs_review` with specific
questions. Do not guess merely to produce a ready result.

## Split releases

Detect unrelated characters or releases from archive names, top-level paths,
model-part names, readmes, and renders. Split them into child model folders.
Do not split one character's poses, scales, clothing, bases, accessories,
alternate heads, NSFW variants, or supported variants.

Every finished output must independently contain:

```text
<model-folder>/
  metadata.json
  images/
  models/
```

Assign each source asset to an output. An output may share original Telegram
message IDs when one source archive genuinely contains several characters.
Remove the parent `models/` after a completed split so FolderUploader cannot
mistake the parent for an unfinished model.

## Normalize images

Move retained renders and Telegram attachments directly into `images/`; leave
no nested image directories. Resolve filename collisions deterministically and
never overwrite an image. Exclude retained images from the rebuilt model
archive.

Compare `photo_*` attachments with extracted renders. Run the read-only helper
at `scripts/detect_duplicate_images.py` relative to this skill when Pillow is
available. Remove a lower-resolution Telegram duplicate only after a confident
visual match. Report uncertain assignments as `needs_review`.

## Preserve metadata

- Match the reference's top-level keys and nested `metadata` keys.
- Keep `modelName` character-specific and keep `artist` at the top level.
- Preserve `source.channelId`, `source.bundleKey`, source links, and only
  original Telegram message IDs. Repartition IDs when evidence supports it.
- Keep `result` null; FolderUploader writes the upload result later.
- Set dates, NSFW, pre-supported, archive, source, URL, and tags only when
  supported by filenames, paths, documents, renders, or reliable research.
- Do not place secrets, cleanup reports, or temporary paths in metadata.

## Repack and verify

Create exactly one LZMA2 `.7z` archive in each output's `models/` directory:

```bash
7z a -t7z -m0=lzma2 "<Artist> - <YYYY>-<MM> - <Character>.7z" <model-content>
```

Preserve useful internal model directories. Do not retain successfully
incorporated nested archives. Run `7z t` and list the finished archive before
removing original or loose model assets.

Before returning `ready`, confirm that every output:

- has the reference metadata shape and preserved Telegram provenance;
- contains exactly one tested archive in `models/`;
- contains a flat `images/` directory;
- contains no symlinks, temporary files, nested source archives, or report files;
- represents a complete model or a complete, unambiguous split.

Return the structured response requested by the caller. List absolute output
folder paths. Put the completion summary in the response, never in the staging
folder.
