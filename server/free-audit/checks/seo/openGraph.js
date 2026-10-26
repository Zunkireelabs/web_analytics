export default function openGraph({ $ }) {
  const has = (prop) => !!($(`meta[property="og:${prop}"]`).attr('content') || '').trim();
  const title = has('title');
  const description = has('description');
  const image = has('image');
  const count = [title, description, image].filter(Boolean).length;

  return {
    id: 'open-graph',
    title: 'Facebook Open Graph Tags',
    category: 'seo',
    passed: count === 3,
    score: count * 2,
    maxScore: 6,
    message: `${count}/3 core Open Graph tags found (title, description, image).`,
    recommendation: count === 3 ? 'No action needed.' : 'Add og:title, og:description and og:image meta tags.',
  };
};
