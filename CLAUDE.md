# Before fixing a bug in this repo

Run `node server/scripts/engineering-lessons.js --file <path>` (one `--file` per
file you're about to touch) before making the fix. It looks up
`engineering_fix_lessons` — a table of generalized lessons from past bugs
fixed in this repo — and prints any that apply to the kind of code you're
about to change, so a bug class already fixed once doesn't get repeated.

Add `--keywords "term,term"` if you already know something about the bug
that the file path alone won't surface (e.g. `--keywords "hook,useEffect"`
for a hook-ordering crash). Use `--all` to list every recorded lesson by eye
if the auto-match comes back empty and you want to double check.

This is separate from `fix_lessons` (content-generation corrections, injected
automatically into LLM generator prompts) — `engineering_fix_lessons` is
application/code bugs, looked up manually via this script since no generator
or agent in this repo edits its own source code.

# After fixing a bug, before `gh pr create` on a fix/* branch

Run `node server/scripts/extract-branch-lesson.js` (dry run — no `--commit`
yet). It classifies the branch's diff and, if it's a genuine code bug fix,
prints an extracted lesson in the same shape as the table above. Show it to
the user for a quick approve/edit — do not insert it silently.

Once the PR is created and approved, insert it with:
`node server/scripts/extract-branch-lesson.js --commit --source-ref <PR URL>`

This is how `engineering_fix_lessons` keeps growing after the one-time
backfill (`server/scripts/backfill-engineering-lessons.js`) — every future
fix feeds the same table its own future fixes will be checked against.
