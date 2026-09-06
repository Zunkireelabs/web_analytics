import { getSiteById } from '../../store/read.js';
import { callLLM } from '../../llm.js';

export const COMPLIANCE_DISCLAIMER = 'This is a draft template generated from data actually detected on ' +
  'this site, not legal advice. Have it reviewed by a qualified legal professional before publishing.';

// Shared generate() body for the three trust/compliance page generators
// (cookie-policy/privacy-policy/terms-of-service) — same JSON-draft shape,
// same "use ONLY the real facts given, never invent" constraint (mirrors
// landing-page.js's own "don't invent claims" instruction), and same
// disclaimer. Only the page label and which real facts matter differ per
// page type, passed in by each generator's own thin wrapper.
export async function generateCompliancePage({ siteId, params, pageLabel, factsGuidance, requiredSections, maxTokens = 1300 }) {
  const site = await getSiteById(siteId);
  const siteName = params?.siteName || site?.name || null;
  const domain = params?.domain || site?.website_domain || null;
  const cookiesObserved = Array.isArray(params?.cookiesObserved) ? params.cookiesObserved : [];
  const trackersDetected = Array.isArray(params?.trackersDetected) ? params.trackersDetected : [];
  if (!siteName && !domain) throw Object.assign(new Error('siteName or domain is required'), { status: 400 });

  const facts = { siteName, domain, cookiesObserved, trackersDetected };

  // Two different kinds of claim get two different rules: anything about
  // what THIS site specifically collects/tracks/does must come only from
  // `facts` (never invented) — but a real policy also needs standard
  // sections (user rights, retention, how to control cookies via browser
  // settings, contact) that are true for any site regardless of what was
  // detected here. Without spelling those out by name, an empty
  // cookiesObserved/trackersDetected made the model fall back to a
  // one-paragraph stub (confirmed live on zunkireelabs.com's /privacy/ and
  // /cookie/ — both shipped with just an Introduction + a single "none
  // detected" line) instead of a genuinely complete page.
  const sectionsList = requiredSections?.length
    ? `\n\nA complete ${pageLabel} also needs these standard sections, which are true for any site regardless of ` +
      `what was detected — write them as normal generic policy language, not a site-specific claim: ` +
      `${requiredSections.join('; ')}. Always include every one of these, in addition to whatever the real ` +
      'detected facts support.'
    : '';
  const system = `You are drafting a ${pageLabel} page for a website. Use ONLY the real facts given below for any ` +
    'claim about what this specific site actually collects, tracks, or does — the site\'s own name/domain, and ' +
    'the cookies/trackers actually detected on it. Never invent a cookie name, third-party service, jurisdiction, ' +
    `or site-specific data claim not present in the given facts. ${factsGuidance}${sectionsList} ` +
    'Respond with ONLY a JSON object: {"headline": "...", "sections": [{"heading": "...", "body": "..."}], ' +
    '"metaTitle": "...", "metaDescription": "..."}';
  const raw = await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens });

  let parsed;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw Object.assign(new Error(`${pageLabel} generation failed: model did not return valid JSON`), { status: 400 });
  }

  const content = {
    headline: parsed.headline || pageLabel,
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    metaTitle: parsed.metaTitle || `${pageLabel} — ${siteName || domain}`,
    metaDescription: parsed.metaDescription || '',
    disclaimer: COMPLIANCE_DISCLAIMER,
    factsUsed: facts,
  };
  return { content, summary: `${pageLabel} draft for ${siteName || domain}` };
}
