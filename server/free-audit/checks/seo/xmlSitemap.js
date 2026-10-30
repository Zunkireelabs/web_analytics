export default function xmlSitemap({ sitemap }) {
  const present = sitemap.present === true;

  return {
    id: 'xml-sitemap',
    title: 'XML Sitemaps',
    category: 'seo',
    passed: sitemap.present === null ? null : present,
    score: present ? 6 : 0,
    maxScore: sitemap.present === null ? 0 : 6,
    message: present
      ? `Sitemap found at ${sitemap.url}.`
      : sitemap.present === null
      ? 'Could not verify sitemap presence.'
      : 'No XML sitemap found at /sitemap.xml or referenced in robots.txt.',
    recommendation: present ? 'No action needed.' : 'Add an XML sitemap and reference it in robots.txt.',
  };
};
