export default function facebookPixel({ $ }) {
  let found = false;

  $('script').each((_, el) => {
    if (found) return;
    const src = ($(el).attr('src') || '').toLowerCase();
    if (src.includes('connect.facebook.net')) {
      found = true;
      return;
    }
    const body = $(el).contents().text();
    if (/\bfbq\s*\(/.test(body)) {
      found = true;
    }
  });

  return {
    id: 'facebook-pixel',
    title: 'Facebook Pixel',
    category: 'seo',
    passed: found,
    score: found ? 2 : 0,
    maxScore: 2,
    message: found ? 'A Facebook Pixel was detected.' : 'No Facebook Pixel detected.',
    recommendation: found
      ? 'No action needed.'
      : 'If you run Facebook/Instagram ads, install a Facebook Pixel to track conversions and build retargeting audiences.',
  };
};
