export default function imageAlt({ $ }) {
  const images = $('img');
  const total = images.length;

  if (total === 0) {
    return {
      id: 'image-alt',
      title: 'Image Alt Attributes',
      category: 'seo',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'No images found on this page.',
      recommendation: 'No action needed.',
    };
  }

  let withAlt = 0;
  images.each((_, el) => {
    if (($(el).attr('alt') || '').trim().length > 0) withAlt += 1;
  });
  const coverage = withAlt / total;
  const ok = coverage >= 0.8;

  return {
    id: 'image-alt',
    title: 'Image Alt Attributes',
    category: 'seo',
    passed: ok,
    score: Math.round(coverage * 6),
    maxScore: 6,
    message: `${withAlt}/${total} images have alt text (${Math.round(coverage * 100)}%).`,
    recommendation: ok ? 'No action needed.' : 'Add descriptive alt text to images missing it.',
  };
};
