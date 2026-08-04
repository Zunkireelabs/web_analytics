import { generateCompliancePage } from './lib/compliance-draft.js';

export const meta = {
  id: 'cookie-policy',
  name: 'Cookie Policy Generator',
  description: 'Drafts a Cookie Policy page using only the cookies and trackers actually detected on the site — never a generic template.',
  recommendationTags: [],
};

// params: { siteName?, domain?, cookiesObserved?: string[], trackersDetected?: string[] }
// (as produced by trust-compliance.js's recommendedAction.params)
export async function generate({ siteId, params }) {
  return generateCompliancePage({
    siteId, params, pageLabel: 'Cookie Policy',
    factsGuidance: 'If cookiesObserved or trackersDetected is empty, say so plainly (e.g. "no third-party ' +
      'tracking cookies were detected on this site") instead of padding with generic industry-standard cookie ' +
      'boilerplate.',
  });
}
