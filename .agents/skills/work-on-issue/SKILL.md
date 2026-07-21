---
name: work-on-issue
description: Fetch a GitHub issue, create the correct branch, and load relevant docs to begin work
argument-hint: "[issue-number]"
---

The user wants to start working on a GitHub issue for the Alexandria project.

The skill may be invoked with an issue number argument (e.g., `/work-on-issue 42`) or without one.

Follow these steps:

1. **Get the issue number**
   - If an issue number was provided as an argument, use it.
   - If no number was provided, run:
     ```
     gh issue list --repo Rukongai/Alexandria --limit 20
     ```
     Show the list to the user and ask them to pick an issue number.

2. **Fetch issue details**
   ```
   gh issue view <number> --repo Rukongai/Alexandria
   ```
   Read the title, body, and labels carefully.

3. **Determine branch type**
   - If the issue has a `bug` label → use `fix/` prefix
   - If the issue has an `enhancement` label → use `feat/` prefix
   - If unclear → ask the user

4. **Create a branch slug** from the issue title:
   - Lowercase, replace spaces/special chars with hyphens
   - Keep it short (3–5 words max)
   - Example: issue #42 "Fix thumbnail generation crash" → `fix/42-thumbnail-generation-crash`

5. **Create and switch to the branch**
   ```
   git checkout main && git pull && git checkout -b <branch-name>
   ```

6. **Load relevant docs** based on issue type:

   For a **bug** (`fix/` branch):
   - Read `docs/ARCHITECTURE.md` — locate the service boundary
   - Read `docs/CONVENTIONS.md` — confirm correct patterns
   - Read `docs/TYPES.md` if the bug involves API contracts or shared types

   For a **feature** (`feat/` branch):
   - Read `docs/ARCHITECTURE.md` — understand where the feature fits
   - Read `docs/TYPES.md` — identify new or changed types
   - Read `docs/CONVENTIONS.md` — confirm correct patterns
   - Read `docs/API.md` if the feature involves new or modified endpoints

7. **Report to the user**:
   - Issue title and number
   - Branch created
   - Which docs were loaded
   - A brief summary of the issue and the relevant area(s) identified from the docs
   - Ask the user how they'd like to proceed, or begin work if instructions are clear
