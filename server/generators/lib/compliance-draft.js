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
export async function generateCompliancePage({ siteId, params, pageLabel, factsGuidance, maxTokens = 900 }) {
  const site = await getSiteById(siteId);
  const siteName = params?.siteName || site?.name || null;
  const domain = params?.domain || site?.website_domain || null;
  const cookiesObserved = Array.isArray(params?.cookiesObserved) ? params.cookiesObserved : [];
  const trackersDetected = Array.isArray(params?.trackersDetected) ? params.trackersDetected : [];
  if (!siteName && !domain) throw Object.assign(new Error('siteName or domain is required'), { status: 400 });

  const facts = { siteName, domain, cookiesObserved, trackersDetected };

  const system = `You are drafting a ${pageLabel} page for a website. Use ONLY the real facts given below — ` +
    'the site\'s own name/domain, and the cookies/trackers actually detected on it. Never invent a cookie name, ' +
    `third-party service, jurisdiction, or legal claim not present in the given facts. ${factsGuidance} ` +
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
