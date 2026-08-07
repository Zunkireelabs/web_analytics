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
      'tracking cookies were detected on this site") instead of inventing specific cookie names or third-party ' +
      'services that were not detected.',
    requiredSections: [
      'What Are Cookies',
      'Cookies We Use (grounded strictly in the given cookiesObserved/trackersDetected facts, per the rule above)',
      'How to Control or Disable Cookies (standard browser-settings guidance — not a site-specific claim)',
      'Changes to This Policy',
      'Contact Us (using the given site name/domain)',
    ],
  });
}
