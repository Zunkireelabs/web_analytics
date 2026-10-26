import { assessLlmsTxtQuality } from '../llmsTxtQuality.js';

export default function llmsTxt({ llmsTxt }) {
  if (llmsTxt.present === null) {
    return {
      id: 'llms-txt',
      title: 'llms.txt',
      category: 'aeo',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'Could not verify llms.txt.',
      recommendation: 'No action needed.',
    };
  }

  const content = (llmsTxt.content || '').trim();
  const present = llmsTxt.present === true && content.length > 0;

  if (!present) {
    return {
      id: 'llms-txt',
      title: 'llms.txt',
      category: 'aeo',
      passed: false,
      score: 0,
      maxScore: 4,
      message: 'No llms.txt file found.',
      recommendation: 'Add a llms.txt file to help LLM crawlers understand your site more efficiently.',
    };
  }

  const { hasH1, longEnough, hasLink, missing, pass } = assessLlmsTxtQuality(content);
  // 1 point for existing, plus one point each for the three format signals below.
  const score = 1 + (hasH1 ? 1 : 0) + (longEnough ? 1 : 0) + (hasLink ? 1 : 0);

  return {
    id: 'llms-txt',
    title: 'llms.txt',
    category: 'aeo',
    passed: pass,
    score,
    maxScore: 4,
    message: pass
      ? 'llms.txt file found and follows the recommended format (H1 title, sufficient content, includes links).'
      : `llms.txt file found, but is missing: ${missing.join(', ')}.`,
    recommendation: pass
      ? 'No action needed.'
      : 'Follow the llms.txt convention: start with a "# Site Name" H1, a short description, and markdown links to key pages so AI models can efficiently navigate your site.',
  };
};
