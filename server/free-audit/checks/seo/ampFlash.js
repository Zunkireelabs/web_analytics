export default function ampFlash({ $ }) {
  const isAmp = $('html').attr('amp') !== undefined || $('html').attr('⚡') !== undefined;
  const hasAmpLink = $('link[rel="amphtml"]').length > 0;
  const hasFlash =
    $('object[type="application/x-shockwave-flash"]').length > 0 || $('embed[src$=".swf"]').length > 0;

  const results = [];

  results.push({
    id: 'amp-usage',
    title: 'Google Accelerated Mobile Pages (AMP)',
    category: 'seo',
    passed: null,
    score: 0,
    maxScore: 0,
    message: isAmp ? 'This page is an AMP page.' : hasAmpLink ? 'An AMP version of this page is linked.' : 'No AMP usage detected.',
    recommendation: 'Informational only.',
  });

  results.push({
    id: 'flash-usage',
    title: 'Flash Used?',
    category: 'seo',
    passed: !hasFlash,
    score: hasFlash ? 0 : 2,
    maxScore: 2,
    message: hasFlash ? 'Legacy Flash content detected on this page.' : 'No legacy Flash content detected.',
    recommendation: hasFlash ? 'Remove Flash content — it is unsupported by modern browsers.' : 'No action needed.',
  });

  return results;
};
