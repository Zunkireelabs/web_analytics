// Shared by the homepage audit (audit-form.js) and the saved report page (audit-report.js).
// Page-derived text (titles, messages, generated code) is only ever inserted with textContent.

export const LABELS = { seo: 'Google SEO', aeo: 'AI answers (AEO)', geo: 'AI citations (GEO)', agentic: 'AI agents' };
const WEIGHTS = { seo: 0.4, aeo: 0.25, geo: 0.25, agentic: 0.1 };
export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// What each failing check means for the visitor, in plain language.
export const WHY = {
  'title-tag': 'The title is the headline people see in Google. A missing or badly sized one costs you clicks.',
  'meta-description': 'This is the snippet under your Google result. A weak one makes people scroll past you.',
  'h1-usage': 'The main heading tells search engines and AI what the page is about.',
  'subheading-usage': 'Subheadings let Google and AI assistants pull out the right section as an answer.',
  'canonical-tag': 'Without it, Google may treat duplicate versions of your page as competing with each other.',
  'mobile-viewport': 'Google ranks the mobile version of your site first. This makes it look broken on phones.',
  'open-graph': 'Links to your site look bare when shared on LinkedIn, Slack and WhatsApp.',
  'schema-org': 'Structured data is how Google and AI understand who you are and what you sell.',
  'noindex-check': 'A noindex tag tells Google to leave this page out of search entirely.',
  'image-alt': 'Missing alt text hides your images from Google Images and from AI that reads the page.',
  'robots-txt': 'robots.txt tells crawlers where they can go. A missing or broken one causes crawl problems.',
  'blocked-by-robots': 'Your robots.txt blocks crawlers from this page, so it cannot be found.',
  'xml-sitemap': 'A sitemap helps Google find and index every page quickly.',
  'ssl-enabled': 'Without HTTPS, browsers warn visitors and Google ranks you lower.',
  'https-redirect': 'Visitors on the insecure address should be sent to the secure one automatically.',
  'content-amount': 'Thin pages give Google and AI little to rank or quote.',
  'llms-txt': 'An llms.txt file is a guide for AI assistants. Without one, they guess what matters on your site.',
  'identity-schema': 'Tells AI exactly who your business is, so it names you correctly in answers.',
  'rich-structured-data': 'Richer structured data gives AI more facts to quote about you.',
  'answerability': 'AI assistants quote pages that answer questions directly. This page does not yet.',
  'local-business-schema': 'Helps you show up for "near me" and local questions in Google and AI.',
  'ai-crawler-access': 'If AI crawlers are blocked, ChatGPT and others cannot read or cite your site.',
  'review-rating-schema': 'Without review markup, AI answers and Google cannot show your ratings, so rivals with reviews look stronger.',
  'comparison-content': 'People ask AI "X vs Y" and "best X for Y". With no comparison content, you are left out of those answers.',
  'external-citations': 'Linking to credible sources makes AI trust your page enough to quote it.',
  'freshness-signals': 'AI prefers recent content. With no dates, your page looks stale.',
  'author-expertise': 'Pages with a named expert are trusted more by Google and AI. This one shows no author.',
  'entity-mentions': 'Naming your company, products and people clearly helps AI connect them to you.',
  'qa-content': 'AI assistants pull answers from question-and-answer content. Without it, they cannot lift a direct answer from you.',
  'page-weight': 'Heavy pages load slowly, which hurts rankings and visitors.',
  'compression': 'Compression makes your pages load faster for everyone.',
  'http2-usage': 'A modern connection protocol that makes pages load faster.',
};


export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
export const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
export const gradeOf = (n) => (n >= 90 ? 'a' : n >= 75 ? 'b' : n >= 60 ? 'c' : n >= 40 ? 'd' : 'f');
export const hostOf = (u) => new URL(u).hostname;

export function overallScore(overall) {
  let sum = 0, weight = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) if (overall[k]) { sum += overall[k].score * w; weight += w; }
  return Math.round(sum / weight);
}

export function verdict(overall) {
  const seo = overall.seo?.score ?? 0;
  const ai = ((overall.aeo?.score ?? 0) + (overall.geo?.score ?? 0)) / 2;
  if (seo >= 75 && ai >= 75) return 'You are in good shape. A few fixes would put you ahead.';
  if (seo >= 75) return 'Google can find you, but AI assistants cannot quote you yet.';
  if (ai >= 75) return 'AI can read your site, but basic SEO problems are holding you back.';
  if (seo < 60 && ai < 60) return 'Search engines and AI assistants are both struggling to understand your site.';
  return 'A solid base, with clear gaps to close in both Google and AI answers.';
}

const GRADE_LABEL = { a: 'Excellent', b: 'Good', c: 'Fair', d: 'Needs work', f: 'Critical gaps' };
const NS = 'http://www.w3.org/2000/svg';
const CATS = [['all', 'All'], ['seo', 'SEO'], ['aeo', 'AEO'], ['geo', 'GEO'], ['agentic', 'Agentic']];

// Circular score gauge that draws in from empty.
function ring(score, { size = 120, stroke = 10 } = {}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const wrap = el('div', `ar-ring ar-ring--${gradeOf(score)}`);
  wrap.style.width = wrap.style.height = `${size}px`;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  const mk = (cls) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', size / 2); c.setAttribute('cy', size / 2); c.setAttribute('r', r);
    c.setAttribute('fill', 'none'); c.setAttribute('stroke-width', stroke); c.setAttribute('class', cls);
    return c;
  };
  const arc = mk('ar-ring__arc');
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-dasharray', circ);
  arc.setAttribute('stroke-dashoffset', reduceMotion ? circ * (1 - score / 100) : circ);
  svg.append(mk('ar-ring__track'), arc);
  const num = el('div', 'ar-ring__num');
  num.append(el('b', '', String(score)), el('span', '', 'out of 100'));
  wrap.append(svg, num);
  if (!reduceMotion) requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', circ * (1 - score / 100))));
  return wrap;
}

// One card: ring, verdict, the pass/fail line and a bar per score.
function summaryCard(data) {
  const total = overallScore(data.overall);
  const g = gradeOf(total);
  const card = el('section', 'ar-card ar-summary');
  card.append(ring(total));

  const body = el('div', 'ar-summary__body');
  const tag = el('p', 'ar-eyebrow');
  tag.append('Overall rating ', el('span', `ar-grade ar-grade--${g}`, `${g.toUpperCase()} · ${GRADE_LABEL[g]}`));
  const stats = el('p', 'ar-summary__stats');
  stats.append(el('b', 'is-good', String(data.counts.passed)), ' passed · ', el('b', 'is-bad', String(data.counts.failing)), ' need attention · ', el('b', '', String(data.counts.total)), ' checks run');
  body.append(tag, el('h2', 'ar-summary__verdict', verdict(data.overall)), stats);

  const metrics = el('div', 'ar-metrics');
  for (const key of Object.keys(LABELS)) {
    const s = data.overall[key];
    if (!s) continue;
    const row = el('div', `ar-metric ar-metric--${gradeOf(s.score)}`);
    const bar = el('div', 'ar-metric__bar');
    const fill = el('i');
    fill.style.width = reduceMotion ? `${s.score}%` : '0%';
    bar.append(fill);
    if (!reduceMotion) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${s.score}%`; }));
    row.append(el('span', 'ar-metric__lbl', LABELS[key]), bar, el('b', 'ar-metric__num', String(s.score)), el('span', `ar-grade ar-grade--${s.grade.toLowerCase()}`, s.grade));
    metrics.append(row);
  }
  body.append(metrics);
  card.append(body);
  return card;
}

function serpCard(data) {
  const meta = data.pageMetadata || {};
  const url = new URL(data.finalUrl);
  const card = el('section', 'ar-card ar-serp');
  card.append(
    el('p', 'ar-eyebrow', 'How you look on Google today'),
    el('span', 'ar-serp__url', url.hostname + (url.pathname === '/' ? '' : url.pathname)),
    el('b', 'ar-serp__title', clip(meta.title || '(no title)', 60)),
    el('span', 'ar-serp__desc', clip(meta.description || 'No description. Google will pick random text from your page.', 160)),
  );
  return card;
}

const catLabel = (c) => (c === 'agentic' ? 'Agentic' : c.toUpperCase());

// A failing check. Locked ones show only the title (the server withholds the rest).
function issueRow(issue) {
  const li = el('li', `ar-issue${issue.locked ? ' is-locked' : ''}`);
  li.dataset.cat = issue.category;
  const row = el('div', 'ar-issue__row');
  row.append(el('span', `ar-sev ar-sev--${issue.severity.toLowerCase()}`, issue.severity), el('b', '', issue.title), el('span', 'ar-cat', catLabel(issue.category)));
  if (issue.locked) row.append(el('span', 'ar-issue__lock', 'We’ll fix this for you'));
  li.append(row);
  if (!issue.locked) {
    li.append(el('p', 'ar-issue__why', WHY[issue.id] || issue.recommendation || ''), el('p', 'ar-issue__found', issue.message));
    if (issue.fix) li.append(fixBlock(issue.fix));
  }
  return li;
}

function passRow(c) {
  const li = el('li', 'ar-pass');
  li.dataset.cat = c.category;
  li.append(el('i', 'ar-pass__tick', '✓'));
  const body = el('div', 'ar-pass__body');
  body.append(el('b', '', c.title), el('span', '', clip(c.message || '', 80)));
  li.append(body, el('span', 'ar-cat', catLabel(c.category)));
  return li;
}

// The results column: summary, Google preview, then the checks with category
// tabs. Used by /audit (teaser) and /report (everything unlocked, fixes inline).
export function dashboard(data) {
  const root = document.createDocumentFragment();
  root.append(summaryCard(data), serpCard(data));

  const bar = el('div', 'ar-checks__bar');
  const tabs = el('div', 'ar-tabs');
  tabs.setAttribute('role', 'tablist');
  bar.append(el('h3', 'ar-checks__title', 'Checks'), tabs);

  const attCard = el('section', 'ar-card');
  const attHead = el('h4', 'ar-card__title');
  const attention = el('ul', 'ar-issues');
  data.issues.forEach((i) => attention.append(issueRow(i)));
  attCard.append(attHead, attention);

  const passCard = el('section', 'ar-card');
  const passHead = el('h4', 'ar-card__title');
  const passed = el('ul', 'ar-passgrid');
  data.passed.forEach((c) => passed.append(passRow(c)));
  passCard.append(passHead, passed);

  const apply = (cat) => {
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.cat === cat)));
    let a = 0, p = 0;
    attention.querySelectorAll('li.ar-issue').forEach((li) => { const show = cat === 'all' || li.dataset.cat === cat; li.hidden = !show; if (show) a += 1; });
    passed.querySelectorAll('li.ar-pass').forEach((li) => { const show = cat === 'all' || li.dataset.cat === cat; li.hidden = !show; if (show) p += 1; });
    passed.scrollTop = 0;
    attHead.textContent = `Needs attention · ${a}`;
    passHead.textContent = `Passed · ${p}`;
    attCard.hidden = a === 0;
    passCard.hidden = p === 0;
  };
  for (const [cat, label] of CATS) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.cat = cat;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => apply(cat));
    tabs.append(b);
  }
  root.append(bar, attCard, passCard);
  apply('all');
  return root;
}

export function fixBlock(fix, heading) {
  const box = el('div', 'ar-fix');
  const head = el('div', 'ar-fix__head');
  head.append(el('b', '', heading || fix.title));
  const copy = el('button', 'ar-fix__copy', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(fix.code); copy.textContent = 'Copied'; } catch { copy.textContent = 'Press ⌘C'; }
    setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
  });
  head.append(copy);
  const pre = el('pre');
  pre.append(el('code', '', fix.code));
  box.append(head);
  if (fix.where) box.append(el('p', 'ar-fix__where', fix.where));
  box.append(pre);
  if (fix.note) box.append(el('p', 'ar-fix__note', fix.note));
  return box;
}

