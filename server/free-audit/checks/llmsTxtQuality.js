function assessLlmsTxtQuality(content) {
  const trimmed = (content || '').trim();
  const firstLine = trimmed.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  const hasH1 = /^#\s+\S/.test(firstLine);
  const longEnough = trimmed.length >= 200;
  const hasLink = /\[[^\]]+\]\([^)]+\)/.test(trimmed);

  const missing = [];
  if (!hasH1) missing.push('a top-level "# Title" heading');
  if (!longEnough) missing.push('enough content (it looks too short)');
  if (!hasLink) missing.push('at least one markdown link');

  return { hasH1, longEnough, hasLink, missing, pass: missing.length === 0 };
}

export { assessLlmsTxtQuality };
