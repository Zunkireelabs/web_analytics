## STRICT DESIGN PRESERVATION — NEVER BREAK THE EXISTING WEBSITE

Before generating, editing, expanding, or fixing **any page, section, component, template, blog, landing page, or SEO content**, the agent MUST first understand and preserve the website's existing visual design.

### 1. LIVE WEBSITE IS THE SOURCE OF TRUTH

Do NOT assume that a page should follow a generic design system, common SaaS pattern, Tailwind defaults, or another client's design.

For each site/tenant:

* Inspect the actual existing website.
* Inspect existing pages, sections, components, layouts, spacing, typography, colors, borders, cards, buttons, images, icons, navigation, footer, forms, and responsive behavior.
* Identify how different page types are actually designed.
* Use the existing implementation as the primary source of truth.
* The design of one client MUST NEVER be copied onto another client.

### 2. PRESERVE EVERY EXISTING SECTION

When modifying or generating a page:

* Do NOT remove existing sections unless the task explicitly requires removal.
* Do NOT reorder sections unnecessarily.
* Do NOT flatten the page into a simpler/generic layout.
* Do NOT replace existing components with generic components just because they are easier to generate.
* Preserve existing spacing, hierarchy, proportions, visual rhythm, and interaction patterns.
* Preserve the relationship between headings, paragraphs, cards, images, CTAs, forms, and supporting content.
* Existing sections must continue to look like they belong to the same website.

### 3. SIMILAR PAGE ≠ SAME DESIGN

If an existing page appears similar to another page, do NOT blindly copy the other page.

First determine:

1. Is this actually the same template?
2. Is it a variation of an existing template?
3. Does this page have unique sections?
4. What visual rules are specific to this page?
5. What does the live website currently do?

If there is no exact matching template, construct the new page using the **actual visual language of the website**, not a generic template.

### 4. GENERATED CONTENT MUST FIT THE EXISTING DESIGN

When the SEO/content agent generates:

* blog pages
* service pages
* location pages
* landing pages
* comparison pages
* FAQ sections
* resource pages
* new sections
* internal-link blocks
* CTAs
* schema-related content

the content must be inserted into the existing design system without visually breaking it.

The agent must adapt the content to the available components rather than redesigning the website to fit the generated content.

### 5. NEVER CREATE "FLAT" OR GENERIC DESIGN

Do not produce pages that look like:

* plain text followed by cards
* generic AI landing pages
* arbitrary full-width sections
* random gradients
* random colors
* inconsistent card sizes
* excessive whitespace
* incorrect typography
* arbitrary font sizes
* unrelated button styles
* inconsistent border radius
* inconsistent shadows
* unrelated icons
* sections copied from another website/client
* layouts that technically work but visually do not belong to the website

A page can be technically valid and still be a DESIGN FAILURE.

### 6. MAINTAIN VISUAL CONSISTENCY

For every generated or modified page, verify consistency with the existing website for:

* H1/H2/H3 hierarchy
* font family
* font sizes
* font weights
* line heights
* paragraph sizing
* section spacing
* container width
* card dimensions
* grid behavior
* border radius
* borders
* shadows
* button styles
* colors
* image treatment
* icon treatment
* alignment
* navigation
* footer
* responsive behavior
* mobile layout
* desktop layout

Do not make a single component look correct while causing the surrounding page to become visually inconsistent.

### 7. DESIGN AGENT MUST INSPECT BEFORE DECIDING

Before making a design-related change:

**DISCOVER → INSPECT → UNDERSTAND → COMPARE → DECIDE → IMPLEMENT → VISUALLY VALIDATE**

The agent must inspect the existing implementation and, where possible, render/capture the affected page before deciding what to change.

Do not make design decisions from the HTML structure alone.

### 8. VISUAL VALIDATION IS REQUIRED

After generating or modifying a page:

1. Render the page.
2. Compare it against the existing website.
3. Check every major section.
4. Check desktop and responsive behavior.
5. Confirm that no existing component was unintentionally changed.
6. Confirm that typography and spacing remain consistent.
7. Confirm that the page looks like it was created by the same website team.

If the generated page looks technically correct but visually different from the existing website, FIX IT before shipping.

### 9. PROTECT EXISTING DESIGN

The agent must treat the existing design as a protected system.

Do not "improve" the design simply because another design appears cleaner, newer, or more modern.

Do not redesign existing components during an unrelated SEO/content task.

Only change existing design when:

* the task explicitly requests a design change, OR
* the current implementation is demonstrably broken, OR
* the Design Agent identifies a real consistency defect and can fix it without breaking other pages.

### 10. MULTI-TENANT RULE

This system is multi-tenant.

Every site has its own:

* design language
* typography
* components
* spacing
* templates
* colors
* page structures
* responsive behavior
* content hierarchy

Therefore:

**NEVER apply one client's design rules to another client.**

The Design Agent must discover and store design patterns **per site/tenant**.

### FINAL RULE

Before shipping ANY generated or modified page, ask:

> "If I opened this page without knowing it was generated by an agent, would it look like a natural part of this existing website?"

If the answer is no, the work is NOT finished.

The goal is not merely to generate a valid webpage.

The goal is to generate a webpage that is **visually native to the existing website and does not break any existing design, section, component, template, spacing, hierarchy, or responsive behavior.**

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
