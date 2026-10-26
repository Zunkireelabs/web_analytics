export default function langAttribute({ $ }) {
  const lang = ($('html').attr('lang') || '').trim();

  return {
    id: 'lang-attribute',
    title: 'Language Attribute',
    category: 'seo',
    passed: !!lang,
    score: lang ? 3 : 0,
    maxScore: 3,
    message: lang ? `<html lang="${lang}">` : 'No lang attribute found on the <html> tag.',
    recommendation: lang ? 'No action needed.' : 'Add a lang attribute to the <html> tag, e.g. <html lang="en">.',
  };
};
