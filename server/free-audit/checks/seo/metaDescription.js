export default function metaDescription({ $ }) {
  const desc = ($('meta[name="description"]').attr('content') || '').trim();
  const len = desc.length;

  if (!desc) {
    return {
      id: 'meta-description',
      title: 'Meta Description',
      category: 'seo',
      passed: false,
      score: 0,
      maxScore: 8,
      message: 'No meta description found.',
      recommendation: 'Add a meta description between 120-160 characters summarizing the page.',
    };
  }

  const ideal = len >= 120 && len <= 160;
  return {
    id: 'meta-description',
    title: 'Meta Description',
    category: 'seo',
    passed: ideal,
    score: ideal ? 8 : 4,
    maxScore: 8,
    message: `Meta description is ${len} characters.`,
    recommendation: ideal
      ? 'No action needed.'
      : 'Adjust meta description length to be between 120-160 characters.',
  };
};
