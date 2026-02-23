---
name: new-feature-issue
description: Interactively create a new feature request GitHub issue for the Alexandria project
---

The user wants to create a new feature request issue on GitHub for the Alexandria project.

Follow these steps:

1. Ask the user for the following information (ask all at once in a single message):
   - **Title**: A short, descriptive title for the feature
   - **Description**: What should this feature do? What problem does it solve?
   - **Domains involved**: Which agents/layers are needed? (frontend / backend / database — pick all that apply)
   - **Priority**: P2 (significant) or P3 (nice-to-have)
   - **Implementation notes** (optional): Any known approach, constraints, or files to touch

2. Based on the answers, derive the appropriate GitHub labels:
   - Always include: `enhancement`
   - Each domain → `area:frontend`, `area:backend`, `area:database` (include all that apply)
   - Priority → `priority:p2` or `priority:p3`

3. Create the issue using the gh CLI:

```
gh issue create \
  --repo Rukongai/Alexandria \
  --title "<title>" \
  --body "<body>" \
  --label "enhancement,<area-labels>,<priority-label>"
```

Use this body format:
```
## Description
<what the feature does and what problem it solves>

## Implementation Notes
<known approach, constraints, or "TBD">

## Files to Touch
<known files, or "TBD">
```

4. Report the URL of the created issue to the user.
