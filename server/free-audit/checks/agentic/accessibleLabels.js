function hasAccessibleName($, el) {
  const $el = $(el);
  if (($el.attr('aria-label') || '').trim().length > 0) return true;
  if (($el.attr('aria-labelledby') || '').trim().length > 0) return true;
  if (($el.text() || '').trim().length > 0) return true;

  const id = $el.attr('id');
  if (id && $(`label[for="${id}"]`).length > 0) return true;

  if ((el.tagName || '').toLowerCase() === 'input' && (($el.attr('type') || '').toLowerCase() === 'image')) {
    return (($el.attr('alt') || '').trim().length > 0);
  }

  return false;
}

export default function accessibleLabels({ $ }) {
  const elements = $('button, a[href], input, select, textarea');
  const total = elements.length;

  if (total === 0) {
    return {
      id: 'accessible-labels',
      title: 'Accessible Names for Interactive Elements',
      category: 'agentic',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'No interactive elements found on this page.',
      recommendation: 'No action needed.',
    };
  }

  let labeled = 0;
  elements.each((_, el) => {
    if (hasAccessibleName($, el)) labeled += 1;
  });
  const coverage = labeled / total;
  const pass = coverage >= 0.9;

  return {
    id: 'accessible-labels',
    title: 'Accessible Names for Interactive Elements',
    category: 'agentic',
    passed: pass,
    score: pass ? 1 : 0,
    maxScore: 1,
    message: `${labeled}/${total} buttons, links, and form fields have an accessible name (${Math.round(coverage * 100)}%).`,
    recommendation: pass
      ? 'No action needed.'
      : 'Add visible text, aria-label, or an associated <label> to interactive elements missing an accessible name — AI agents rely on this to identify what a control does, the same way screen readers do.',
  };
};
