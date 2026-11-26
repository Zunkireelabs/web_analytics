# Acceptance evidence

Generated 2026-11-25T16:16:34.611Z against the throwaway local database. 22/22 scenarios pass.

| Scenario | Result | Tests | What it proves |
|---|---|---|---|
| G1 | PASS | 2 | Multiple agents on one client never conflict: a changed file is rebuilt, a held path is blocked |
| G2 | PASS | 3 | Up to five validated blogs are consolidated into ONE delivery per client (ceiling, never a quota) |
| G3 | PASS | 7 | Existing published blogs, drafts, open PRs and merged content are never duplicated |
| G4 | PASS | 27 | A design-sensitive change passes REAL design validation (real browser, template baseline, both widths) |
| G5 | PASS | 5 | A failed fix is repaired within limits or safely blocked with its content kept |
| G6 | PASS | 6 | A GitHub rate limit loses nothing: the work is preserved and conditional reads cost no quota |
| G7 | PASS | 12 | A worker restart or a server deploy keeps progress; a finished answer is never lost |
| G8 | PASS | 7 | Every client gets an independent delivery record; one failing never stops the others |
| G9 | PASS | 3 | A blocked PR produces a preserved delivery: branch, items, exact error, recovery command |
| G10 | PASS | 2 | Finishing the approved backlog triggers new research; an empty backlog never stops it |
| G11 | PASS | 2 | No quota filling: fewer eligible ships fewer, none ships none, nothing is manufactured |
| G12 | PASS | 1 | Cannibalisation is rejected, naming the page |
| G13 | PASS | 2 | A fabricated claim is blocked and quarantined; sibling articles still ship |
| G14 | PASS | 2 | Abandoned drafts keep their content and never block a new topic |
| R1 | PASS | 3 | Business relevance decides, not keyword volume alone (low volume + high fit passes; high volume + off-business fails) |
| R2 | PASS | 2 | A missing design baseline is captured first; it is never assumed to pass |
| R3 | PASS | 12 | pr_opened, human_merged and production_verified are separate, recorded facts (real database) |
| R4 | PASS | 2 | A project with zero eligible work still gets a completed daily record |
| R5 | PASS | 1 | Database failure: the process survives, nothing recorded is lost, recording resumes |
| R6 | PASS | 7 | Git safety: an agent can never merge; merges by an app account are alerted |
| R7 | PASS | 6 | Per-client isolation: design baselines, content index, research and decisions never cross clients |
| R8 | PASS | 3 | The window, the cron lines and the deadline steps cannot drift apart |

## Tests behind each scenario

### G1: Multiple agents on one client never conflict: a changed file is rebuilt, a held path is blocked
- `server/lib/content-index/content-index.test.js` matching `file that changed after the read is REBUILT|path another in-flight item holds is BLOCKED`: 2 passed

### G2: Up to five validated blogs are consolidated into ONE delivery per client (ceiling, never a quota)
- `server/lib/blog-cycle/blog-cycle.test.js` matching `five articles, one bad and one throwing|ceiling stops at five VALIDATED`: 2 passed
- `server/lib/delivery-consolidation.test.js` matching `pushed work whose PR opens on this attempt ends as delivered`: 1 passed

### G3: Existing published blogs, drafts, open PRs and merged content are never duplicated
- `server/lib/content-index/content-index.test.js` matching `each of the five states is caught|URL-pattern approach would find zero`: 2 passed
- `server/lib/blog-cycle/six-clients.db.test.js` (whole file): 5 passed

### G4: A design-sensitive change passes REAL design validation (real browser, template baseline, both widths)
- `server/lib/design-protection/design-protection.browser.test.js` matching `two agreeing pages give a ready baseline|correct FAQ in the site`: 2 passed
- `server/lib/design-protection/decide-compare-repair.test.js` (whole file): 24 passed
- `server/lib/design-protection/design-protection.browser.test.js` matching `a good FAQ passes end to end`: 1 passed

### G5: A failed fix is repaired within limits or safely blocked with its content kept
- `server/lib/design-protection/design-protection.browser.test.js` matching `wide table is repaired|restyles the nav is quarantined|second H1 is repaired`: 3 passed
- `server/lib/blog-cycle/blog-cycle.test.js` matching `failing article is repaired with the feedback|repairs are bounded`: 2 passed

### G6: A GitHub rate limit loses nothing: the work is preserved and conditional reads cost no quota
- `server/lib/delivery-consolidation.test.js` matching `GitHub rate limit while opening the PR`: 1 passed
- `server/github/client.test.js` matching `conditional GETs`: 5 passed

### G7: A worker restart or a server deploy keeps progress; a finished answer is never lost
- `server/store/llm-requests.recovery.test.js` (whole file): 6 passed
- `server/lib/claude-code-worker.deploy.test.js` (whole file): 2 passed
- `server/lib/claude-code-worker.test.js` matching `finished answer survives`: 4 passed

### G8: Every client gets an independent delivery record; one failing never stops the others
- `server/lib/delivery-cycle.test.js` matching `every project gets a closed record`: 1 passed
- `server/lib/delivery-consolidation.test.js` matching `one project failing does not stop the other five`: 1 passed
- `server/lib/blog-cycle/six-clients.db.test.js` (whole file): 5 passed

### G9: A blocked PR produces a preserved delivery: branch, items, exact error, recovery command
- `server/lib/delivery-consolidation.test.js` matching `PRESERVED with branch|preserved delivery reads as a plain|preserved work is recorded with the exact error`: 3 passed

### G10: Finishing the approved backlog triggers new research; an empty backlog never stops it
- `server/lib/topic-research/topic-research.test.js` matching `EMPTY BACKLOG|ALL clients independently`: 2 passed

### G11: No quota filling: fewer eligible ships fewer, none ships none, nothing is manufactured
- `server/lib/blog-cycle/blog-cycle.test.js` matching `fewer eligible than the ceiling ships fewer`: 1 passed
- `server/lib/topic-research/topic-research.test.js` matching `no quota`: 1 passed

### G12: Cannibalisation is rejected, naming the page
- `server/lib/blog-cycle/blog-cycle.test.js` matching `cannibalisation: a page already ranking`: 1 passed

### G13: A fabricated claim is blocked and quarantined; sibling articles still ship
- `server/lib/blog-cycle/blog-cycle.test.js` matching `statistics with no verified source are a BLOCKING fabrication`: 1 passed
- `server/lib/blog-cycle/six-clients.db.test.js` matching `failed article is quarantined with its content kept while its siblings ship`: 1 passed

### G14: Abandoned drafts keep their content and never block a new topic
- `server/lib/content-index/content-index.test.js` matching `an abandoned draft does not block its topic`: 1 passed
- `server/lib/topic-research/topic-research.db.test.js` matching `quarantine keeps the failed article`: 1 passed

### R1: Business relevance decides, not keyword volume alone (low volume + high fit passes; high volume + off-business fails)
- `server/lib/blog-cycle/blog-cycle.test.js` matching `LOW-volume topic that fits the business is accepted|HIGH-volume topic that does not fit the business is rejected|volume cannot rescue`: 3 passed

### R2: A missing design baseline is captured first; it is never assumed to pass
- `server/lib/design-protection/protect.test.js` matching `NO baseline: capture is requested and the change WAITS|page type with no captured template yet waits`: 2 passed

### R3: pr_opened, human_merged and production_verified are separate, recorded facts (real database)
- `server/lib/delivery-states.test.js` (whole file): 12 passed

### R4: A project with zero eligible work still gets a completed daily record
- `server/lib/delivery-cycle.test.js` matching `nothing eligible, nothing blocked: no-work|every project gets a closed record`: 2 passed

### R5: Database failure: the process survives, nothing recorded is lost, recording resumes
- `server/lib/db-fault.test.js` (whole file): 1 passed

### R6: Git safety: an agent can never merge; merges by an app account are alerted
- `server/store/drafts-agent-cannot-merge.test.js` (whole file): 6 passed
- `server/lib/delivery-states.test.js` matching `merge by an app account is CRITICAL`: 1 passed

### R7: Per-client isolation: design baselines, content index, research and decisions never cross clients
- `server/lib/design-protection/protect.test.js` matching `per-tenant`: 1 passed
- `server/lib/blog-cycle/six-clients.db.test.js` (whole file): 5 passed

### R8: The window, the cron lines and the deadline steps cannot drift apart
- `server/lib/worker-session.test.js` matching `the cron line follows the window`: 2 passed
- `server/lib/delivery-consolidation.test.js` matching `deadline steps follow the window`: 1 passed
