import { assessLlmsTxtQuality } from '../llmsTxtQuality.js';

export default function llmsTxtRecommendations({ llmsTxt }) {
  const present = llmsTxt.present === true && !!(llmsTxt.content || '').trim();

  if (!present) {
    return {
      id: 'llms-txt-recommendations',
      title: 'llms.txt Content Quality',
      category: 'agentic',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'Not applicable — no llms.txt file was found.',
      recommendation: 'No action needed.',
    };
  }

  const { missing, pass } = assessLlmsTxtQuality(llmsTxt.content);

  return {
    id: 'llms-txt-recommendations',
    title: 'llms.txt Content Quality',
    category: 'agentic',
    passed: pass,
    score: pass ? 1 : 0,
    maxScore: 1,
    message: pass
      ? 'llms.txt follows the recommended format (H1 title, sufficient content, includes links).'
      : `llms.txt is missing: ${missing.join(', ')}.`,
    recommendation: pass
      ? 'No action needed.'
      : 'Follow the llms.txt convention: start with a "# Site Name" H1, a short description, and markdown links to key pages so AI models can efficiently navigate your site.',
  };
};
