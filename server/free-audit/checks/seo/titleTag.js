export default function titleTag({ $ }) {
  const title = ($('title').first().text() || '').trim();
  const len = title.length;

  if (!title) {
    return {
      id: 'title-tag',
      title: 'Title Tag',
      category: 'seo',
      passed: false,
      score: 0,
      maxScore: 10,
      message: 'No title tag found.',
      recommendation: 'Add a unique, descriptive <title> tag between 50-60 characters.',
    };
  }

  const ideal = len >= 50 && len <= 60;
  return {
    id: 'title-tag',
    title: 'Title Tag',
    category: 'seo',
    passed: ideal,
    score: ideal ? 10 : 5,
    maxScore: 10,
    message: `Title is "${title}" (${len} characters).`,
    recommendation: ideal
      ? 'No action needed.'
      : 'Adjust title length to be between 50-60 characters for optimal display in search results.',
  };
};
