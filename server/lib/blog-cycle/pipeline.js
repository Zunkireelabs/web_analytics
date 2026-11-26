// ONE FAILED ARTICLE MUST NEVER BLOCK THE OTHERS. Processes a cycle's articles independently: each is generated, validated and, when it fails,
// repaired a bounded number of times, then either VALIDATED (joins the cycle's single consolidated delivery) or QUARANTINED (content kept, reason
// recorded). A thrown error in one article is that article's outcome, never the cycle's. Everything the shipping loop already does per item
// (generateDraft's Quality Gate regeneration) is the real implementation behind `generate`/`validate`/`repair` in production; this orchestration is what
// the blog cycle's consolidation and the acceptance tests rely on, and it is exercised with stand-ins in tests (no model is ever called there).
export const MAX_REPAIRS = 2;

/**
 * @param items     [{ id, topic, ... }] already evidence-accepted topics, best first; at most `ceiling` are processed
 * @param deps      { generate(item, feedback|null) -> content, validate(content, item) -> { issues }, repair?(item, content, issues) -> feedback string|null,
 *                    record?(item, outcome), quarantine?(item, content, issues) }
 * @returns {{ validated: Array, quarantined: Array, failed: Array, skipped: Array, results: Array }}
 */
export async function processArticlesIndependently(items, deps, { ceiling = 5, maxRepairs = MAX_REPAIRS } = {}) {
  const { generate, validate, repair = null, record = async () => {}, quarantine = async () => {} } = deps;
  const results = []; const validated = []; const quarantined = []; const failed = []; const skipped = [];
  const queue = [...(items || [])];
  for (const item of queue) {
    if (validated.length >= ceiling) { skipped.push({ item, reason: `the cycle's ceiling of ${ceiling} validated article(s) was reached` }); results.push({ item, outcome: 'skipped' }); continue; }
    let content = null; let issues = []; let feedback = null; let repairs = 0;
    try {
      for (;;) {
        content = await generate(item, feedback);
        issues = (await validate(content, item)).issues.filter((x) => x.blocking !== false);
        if (!issues.length) break;
        if (repairs >= maxRepairs) break;
        feedback = repair ? await repair(item, content, issues) : issues.map((x) => `${x.detail} -> ${x.correction || 'fix this'}`).join('\n');
        if (!feedback) break;                       // nothing can repair it
        repairs++;
      }
    } catch (err) {
      // This article's own failure (a generator error, a refused generation): recorded, and the next article proceeds.
      const r = { item, outcome: 'failed', error: String(err.message || err), repairs };
      failed.push(r); results.push(r);
      await Promise.resolve(record(item, r)).catch(() => {});
      continue;
    }
    if (!issues.length) {
      const r = { item, outcome: 'validated', content, repairs };
      validated.push(r); results.push(r);
      await Promise.resolve(record(item, r)).catch(() => {});
    } else {
      const r = { item, outcome: 'quarantined', content, issues, repairs };
      quarantined.push(r); results.push(r);
      await Promise.resolve(quarantine(item, content, issues, repairs)).catch(() => {});
      await Promise.resolve(record(item, r)).catch(() => {});
    }
  }
  return { validated, quarantined, failed, skipped, results };
}
