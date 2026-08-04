import { generateCompliancePage } from './lib/compliance-draft.js';

export const meta = {
  id: 'terms-of-service',
  name: 'Terms of Service Generator',
  description: 'Drafts a Terms of Service page scoped to the site\'s own name and domain — never an invented liability, jurisdiction, or dispute-resolution clause.',
  recommendationTags: [],
};

// params: { siteName?, domain? } — cookies/trackers aren't relevant to a
// Terms of Service page, but are accepted for a consistent params shape
// with the other two compliance generators.
export async function generate({ siteId, params }) {
  return generateCompliancePage({
    siteId, params, pageLabel: 'Terms of Service',
    factsGuidance: 'This page has no cookie/tracker facts to draw on beyond the site name/domain — keep every ' +
      'clause generic site-usage language (acceptable use, content ownership, no warranty). Do not invent a ' +
      'specific liability cap, governing-law jurisdiction, or dispute-resolution process, since none of those ' +
      'are given as real facts.',
  });
}
