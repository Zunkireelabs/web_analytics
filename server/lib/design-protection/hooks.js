// THE TWO CALL SITES. Every visible change reaches the repository through one of two places; each calls one function here with arguments it already has.
//   protectMarkerSplice  an edit to an EXISTING page: implementers/backend.js, right after the responsive and style-fidelity checks.
//   protectNewPage       a NEW page / article: implementers/frontend.js apply(), right after runDesignGates.
// Both return the orchestrator's result ({ ok, pending, verdict, error, html, repaired, ... }). In the default 'log' mode `ok` is always true and the call
// only RECORDS (what was classified, which baseline, what would have been held). In 'enforce' mode a waiting verdict must be thrown as a pending error
// (toPendingError: the existing design-pending path skips the item, counts nothing and keeps it open) and a block returned as a refusal.
import { protectVisibleChange, toPendingError, describeProtection } from './protect.js';
import { renderableBody } from '../../generators/lib/newpage-render-gate.js';
import { classifyPageType } from '../../design-agent/live-analysis/schema.js';

export { toPendingError, describeProtection };

const frontMatterValue = (body, key) => { const m = String(body || '').match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm')); return m ? m[1].trim() : null; };
const originOf = async (site) => (await import('../../agents/lib/site-domain.js')).siteOriginFor(site);

/** Existing-page edit: `html` is the exact markup being spliced into `marker` on the live page `page`. */
export async function protectMarkerSplice({ site, draft, page, marker, html, files = null, deps = {} }) {
  return protectVisibleChange({
    site, deps,
    change: {
      generatorId: draft.action_type, actionType: draft.action_type, draftId: draft.id ?? null, recommendationId: draft.recommendation_id ?? null, findingId: draft.finding_id ?? null,
      pageUrl: page, marker: String(marker || '').replace(/^SEOAI:/, '').replace(/:(START|END)$/, '') || null, html, files,
      pageType: classifyPageType(page, { propertyType: site?.property_type }),
    },
  });
}

/** New page: `resolved.body` is the rendered source (front matter + markdown/HTML), `resolved.contentFormat` its format. */
export async function protectNewPage({ site, draft, resolved, deps = {} }) {
  const permalink = frontMatterValue(resolved?.body, 'permalink');
  const body = renderableBody(resolved?.body, resolved?.contentFormat);
  const pageType = permalink ? classifyPageType(`https://x.invalid${permalink.startsWith('/') ? '' : '/'}${permalink}`, { propertyType: site?.property_type }) : null;
  return protectVisibleChange({
    site, deps,
    change: {
      generatorId: draft.action_type, actionType: draft.action_type, draftId: draft.id ?? null, recommendationId: draft.recommendation_id ?? null, findingId: draft.finding_id ?? null,
      pageUrl: permalink, pageType, newPage: true, origin: await originOf(site).catch(() => null),
      html: body.skip ? '' : body.html, unrenderable: body.skip ? body.reason : null,
    },
  });
}
