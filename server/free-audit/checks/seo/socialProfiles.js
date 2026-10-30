const PLATFORMS = [
  { name: 'Facebook', pattern: /(^|\.)facebook\.com$/i },
  { name: 'X/Twitter', pattern: /(^|\.)(x|twitter)\.com$/i },
  { name: 'Instagram', pattern: /(^|\.)instagram\.com$/i },
  { name: 'YouTube', pattern: /(^|\.)youtube\.com$/i },
  { name: 'LinkedIn', pattern: /(^|\.)linkedin\.com$/i },
];

export default function socialProfiles({ $, finalUrl }) {
  const found = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    let host;
    try {
      host = new URL(href, finalUrl).hostname;
    } catch {
      return;
    }
    for (const platform of PLATFORMS) {
      if (platform.pattern.test(host)) found.add(platform.name);
    }
  });

  const count = found.size;

  return {
    id: 'social-profiles',
    title: 'Social Media Profiles Linked',
    category: 'seo',
    passed: count > 0,
    score: count,
    maxScore: PLATFORMS.length,
    message:
      count > 0
        ? `${count}/${PLATFORMS.length} social platforms linked (${[...found].join(', ')}).`
        : 'No social media profile links found.',
    recommendation: count > 0 ? 'No action needed.' : 'Link your social media profiles so visitors and search engines can find them.',
  };
};
