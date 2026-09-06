# Before fixing a bug in this repo

Run `node server/scripts/engineering-lessons.js --file <path>` (one `--file` per
file you're about to touch) before making the fix. It prints generalized
lessons from past bugs fixed in this repo that apply to the kind of code
you're about to change, so a bug class already fixed once doesn't get
repeated.

Add `--keywords "term,term"` if you already know something about the bug
that the file path alone won't surface (e.g. `--keywords "hook,useEffect"`
for a hook-ordering crash). Use `--all` to list every recorded lesson by eye
if the auto-match comes back empty and you want to double check.

## Where these lessons actually live

There is ONE store: `agent_fix_memory` (migration 097). Commit `f40fa76`
replaced the two older tables with it — `fix_lessons` (086) and
`engineering_fix_lessons` (087) still exist in the database as a rollback
window but are **dead**: no live code reads or writes either one, and
`server/lessons.js` / `server/engineering-lessons.js` were deleted. Don't add
code against them, and don't trust older comments that describe them as live
(several remain in the tree).

Repo-engineering lessons and client-facing content lessons are still kept
apart, but by column rather than by table:

| | code lessons | client-facing lessons |
|---|---|---|
| `category` | `'code'` | `'content'`, `'technical-seo'`, … |
| `scope` | `'repo'` | `'client'` (or `'global'`) |
| `execution_permission` | always `'informational'` | `requires_approval`, can be promoted to `auto` |
| read by | this CLI, manually | every generator, automatically |

The separation is enforced in SQL, not by convention: `findRelevantMemory`
(`server/agent-memory.js`) hard-excludes `category = 'code'` whenever
`clientFacing` is set, so a content generator can never retrieve a code lesson
however similar the text looks.

Anything written to this table can reach a **different client's** generation
prompt (a row with `site_id NULL` is a cross-tenant wildcard). Every free-text
field on the insert path therefore goes through `sanitizeLessonText`; never
put a URL, client name, or reproduced draft copy into a lesson.

# After fixing a bug, before `gh pr create` on a fix/* branch

Run `node server/scripts/extract-branch-lesson.js` (dry run — no `--commit`
yet). It classifies the branch's diff and, if it's a genuine code bug fix,
prints an extracted lesson in the same shape as the table above. Show it to
the user for a quick approve/edit — do not insert it silently.

Once the PR is created and approved, insert it with:
`node server/scripts/extract-branch-lesson.js --commit --source-ref <PR URL>`

This is how the code-lesson set keeps growing after the one-time backfill
(`server/scripts/backfill-engineering-lessons.js`) — every future fix feeds
the same store its own future fixes will be checked against. The script writes
`category='code'`, `scope='repo'` rows into `agent_fix_memory`, so they stay on
the engineering side of the wall described above.
