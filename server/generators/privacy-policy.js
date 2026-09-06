import { generateCompliancePage } from './lib/compliance-draft.js';

export const meta = {
  id: 'privacy-policy',
  name: 'Privacy Policy Generator',
  description: 'Drafts a Privacy Policy page using only the trackers actually detected on the site — never invented data-collection claims.',
  recommendationTags: [],
};

// params: { siteName?, domain?, cookiesObserved?: string[], trackersDetected?: string[] }
// (as produced by trust-compliance.js's recommendedAction.params)
export async function generate({ siteId, params }) {
  return generateCompliancePage({
    siteId, params, pageLabel: 'Privacy Policy',
    factsGuidance: 'Only describe data collection tied to the trackersDetected/cookiesObserved actually given — ' +
      'do not describe form submissions, account data, payment data, or any other collection practice unless it ' +
      'is one of the given facts. If both are empty, say so plainly (e.g. "no third-party trackers were detected ' +
      'on this site") instead of describing generic data practices.',
    requiredSections: [
      'Information We Collect (grounded strictly in the given trackers/cookies facts, per the rule above)',
      'How We Use Information',
      'Your Privacy Rights (access, correction, and deletion requests)',
      'Data Retention',
      "Children's Privacy",
      'Third-Party Links',
      'Changes to This Policy',
      'Contact Us (using the given site name/domain)',
    ],
  });
}
