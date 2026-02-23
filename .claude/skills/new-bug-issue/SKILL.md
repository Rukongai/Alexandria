---
name: new-bug-issue
description: Interactively create a new bug GitHub issue for the Alexandria project
---

The user wants to create a new bug report issue on GitHub for the Alexandria project.

Follow these steps:

1. Ask the user for the following information (ask all at once in a single message):
   - **Title**: A short, descriptive title for the bug
   - **Symptom**: What is actually happening? (observed behavior)
   - **Expected behavior**: What should happen instead?
   - **Affected area**: Which part of the system? (frontend / backend / database / other)
   - **Priority**: P1 (critical/blocking), P2 (significant), or P3 (minor/cosmetic)
   - **Files to touch** (optional): Any files you already know are involved

2. Based on the answers, derive the appropriate GitHub labels:
   - Always include: `bug`
   - Affected area → `area:frontend`, `area:backend`, or `area:database`
   - Priority → `priority:p1`, `priority:p2`, or `priority:p3`

3. Create the issue using the gh CLI:

```
gh issue create \
  --repo Rukongai/Alexandria \
  --title "<title>" \
  --body "<body>" \
  --label "bug,<area-label>,<priority-label>"
```

Use this body format:
```
## Symptom
<what is actually happening>

## Expected Behavior
<what should happen>

## Root Cause / Suspected Cause
<known root cause, or "Unknown — needs investigation">

## Files to Touch
<list of files, or "TBD">
```

4. Report the URL of the created issue to the user.
