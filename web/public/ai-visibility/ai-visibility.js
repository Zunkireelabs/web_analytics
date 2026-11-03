// AI visibility audit page (/ai-visibility): posts the domain to /api/free-audit (server/routes/free-audit.js), then
// shows how visible the brand is to AI assistants. The score is the average of the AI answers (AEO) and AI citations
// (GEO) scores, the same "AI" number the free audit's verdict uses. Below GOAL it says the site needs improvement and
// offers Start free trial (the Get started flow). See audit-shared.js for the common pieces.
import { reduceMotion, el, gradeOf, hostOf, ring, issueRow, LABELS, attachFavicon } from '/free-audit/audit-shared.js';

const GOAL = 90;
const START_URL = 'https://superrank.si/get-started';
const AI_CATS = ['aeo', 'geo'];

const form = document.querySelector('[data-audit-form]');
if (form) {
  const err = document.querySelector('[data-audit-err]');
  const out = document.querySelector('[data-audit-result]');
  const input = form.elements.website;
  const button = form.querySelector('button[type="submit"]');
  const field = input.closest('.audit-form__field');
  attachFavicon(input, field);
  const title = document.querySelector('[data-audit-title]');
  const sub = document.querySelector('[data-audit-sub]');
  const validSite = (v) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(v);

  const SCAN_STEPS = [
    'Fetching your homepage',
    'Testing whether AI crawlers can get in',
    'Checking llms.txt and structured data',
    'Looking for answer-ready content',
    'Checking for citations and brand mentions',
    'Scoring your AI visibility',
  ];

  const showError = (msg) => { err.textContent = msg; err.hidden = false; };
  const post = async (path, body) => {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
    return data;
  };

  // Scanning panel while the audit runs. Returns a function that stops it.
  function startScan(site) {
    out.replaceChildren();
    out.hidden = false;
    const card = el('section', 'ar-card ar-scan');
    const head = el('p', 'ar-eyebrow');
    head.append('Checking ', el('b', '', site.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')), '…');
    const bar = el('div', 'audit-bar');
    const fill = el('i');
    bar.append(fill);
    const list = el('ul', 'audit-steps');
    const items = SCAN_STEPS.map((t) => { const li = el('li', '', t); list.append(li); return li; });
    card.append(head, bar, list);
    out.append(card);

    let i = 0;
    const tick = () => {
      items.forEach((li, n) => { li.className = n < i ? 'is-done' : n === i ? 'is-now' : ''; });
      fill.style.width = `${Math.min(92, ((i + 1) / items.length) * 92)}%`;
      if (i < items.length - 1) i += 1;
    };
    tick();
    const timer = reduceMotion ? null : setInterval(tick, 1300);
    return () => clearInterval(timer);
  }

  const aiScore = (overall) => Math.round(AI_CATS.reduce((sum, k) => sum + (overall[k]?.score ?? 0), 0) / AI_CATS.length);

  function headline(score) {
    if (score >= GOAL) return 'AI assistants can find, read and quote your brand.';
    if (score >= 75) return 'AI can read most of your site, but a few gaps keep you out of its answers.';
    if (score >= 50) return 'AI assistants only partly see your brand. Fixing the gaps below gets you cited.';
    return 'AI assistants can barely see your brand. They are likely recommending your competitors instead.';
  }

  // The questions an AI assistant asks about a brand before it recommends it, each answered from the checks.
  const QUESTIONS = [
    ['Can AI get into your site?', ['ai-crawler-access', 'llms-txt', 'js-render-gap']],
    ['Does AI know who you are?', ['identity-schema', 'entity-mentions', 'local-business-schema']],
    ['Can AI quote your content?', ['answerability', 'qa-content', 'rich-structured-data']],
    ['Will AI recommend you over rivals?', ['comparison-content', 'review-rating-schema', 'external-citations', 'freshness-signals', 'author-expertise']],
  ];
  const ANSWER = { yes: ['a', 'Yes'], partly: ['c', 'Partly'], no: ['f', 'No'] };

  // What the homepage tells AI about the brand, in the page's own words.
  function readCard(t) {
    const m = t.pageMetadata || {};
    const card = el('section', 'ar-card');
    card.append(el('h4', 'ar-card__title', 'What AI reads about you'));
    const quote = el('div', 'aiv-read');
    quote.append(el('b', '', m.title || 'No page title found'), el('span', '', m.description || 'No meta description found, so AI has to guess what you do.'));
    card.append(quote);
    return card;
  }

  function questionsCard(checks) {
    const byId = (id) => checks.find((c) => c.id === id && AI_CATS.includes(c.category));
    const card = el('section', 'ar-card');
    card.append(el('h4', 'ar-card__title', 'How AI sees your brand'));
    const list = el('ul', 'aiv-qs');
    for (const [question, ids] of QUESTIONS) {
      const found = [...new Map(ids.map((id) => [id, byId(id)]).filter(([, c]) => c)).values()];
      if (!found.length) continue;
      const bad = found.filter((c) => c.failing);
      const answer = !bad.length ? 'yes' : bad.length === found.length ? 'no' : 'partly';
      const [grade, label] = ANSWER[answer];
      const li = el('li', 'aiv-q');
      const row = el('div', 'aiv-q__row');
      row.append(el('b', '', question), el('span', `ar-grade ar-grade--${grade}`, label));
      li.append(row);
      li.append(el('p', 'aiv-q__note', bad.length ? `Missing: ${bad.map((c) => c.title).join(', ')}.` : 'Everything AI looks for here is in place.'));
      list.append(li);
    }
    card.append(list);
    return card;
  }

  // Below the goal: say it needs fixing, then the Get started link right under it.
  function nextStep(score, issues) {
    const box = el('section', `ar-card ar-aside${score < GOAL ? '' : ' ar-aside--dark'}`);
    if (score < GOAL) {
      box.append(
        el('h3', 'ar-aside__title', 'Your AI visibility needs improvement'),
        el('p', 'ar-aside__text', issues ? `${issues} ${issues === 1 ? 'check is' : 'checks are'} holding your AI visibility back. Start your free trial and the SuperRank agent writes the fix for each one and ships it for your approval.` : 'Start your free trial and the SuperRank agent keeps your AI visibility climbing.'),
      );
    } else {
      box.append(
        el('h3', 'ar-aside__title', 'You are visible to AI. Keep it that way.'),
        el('p', 'ar-aside__text', 'Start your free trial and SuperRank watches for changes that could drop you out of AI answers.'),
      );
    }
    const start = el('a', 'btn btn--primary btn--lg', 'Start free trial');
    start.href = START_URL;
    box.append(start, el('small', '', '14-day free trial · no credit card'));
    return box;
  }

  function bookCard(host) {
    const box = el('section', 'ar-card ar-aside ar-aside--dark');
    box.append(el('h3', 'ar-aside__title', 'Prefer to talk it through?'), el('p', 'ar-aside__text', 'Book 30 minutes on your own site. We show you where AI assistants skip your brand, and what we would fix first.'));
    const demo = el('a', 'btn btn--primary btn--lg', 'Book a demo');
    demo.href = `https://superrank.si/book-demo?website=${encodeURIComponent(host)}&intent=ai-visibility`;
    box.append(demo);
    return box;
  }

  // Left column: the score and what it means.
  function summaryAside(t, score, checks) {
    const g = gradeOf(score);
    const passed = checks.filter((c) => !c.failing).length;
    const box = el('aside', 'rs-sum');
    const head = el('div', 'rs-sum__ring');
    head.append(ring(score, { size: 132, stroke: 11 }), el('span', `ar-grade ar-grade--${g}`, `${g.toUpperCase()}`));
    box.append(head, el('p', 'rs-sum__txt', headline(score)));
    const rows = el('div', 'rs-sum__rows');
    const row = (label, value) => { const d = el('div'); d.append(el('span', '', label), el('b', '', value)); return d; };
    for (const key of AI_CATS) if (t.overall[key]) rows.append(row(LABELS[key], String(t.overall[key].score)));
    rows.append(row('Passed', String(passed)), row('Need attention', String(checks.length - passed)));
    box.append(rows);
    return box;
  }

  function render(t) {
    const failing = t.issues.filter((i) => AI_CATS.includes(i.category));
    const passing = t.passed.filter((c) => AI_CATS.includes(c.category));
    const checks = [...failing.map((c) => ({ ...c, failing: true })), ...passing];
    const score = aiScore(t.overall);

    const mid = el('div', 'rs-main');
    mid.append(readCard(t), questionsCard(checks));
    if (failing.length) {
      const fix = el('section', 'ar-card');
      fix.append(el('h4', 'ar-card__title', 'What to fix first'));
      const list = el('ul', 'ar-issues');
      failing.forEach((i) => list.append(issueRow(i)));
      fix.append(list);
      mid.append(fix);
    }

    // Right column, sticky: the Start free trial card, then Book a demo.
    const side = el('aside', 'rs-side');
    side.append(nextStep(score, failing.length), bookCard(hostOf(t.finalUrl)));

    const grid = el('div', 'ar-res3');
    grid.append(summaryAside(t, score, checks), mid, side);
    out.replaceChildren(grid);
    out.hidden = false;
  }

  async function run(site) {
    title.textContent = site.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    sub.textContent = 'AI visibility audit · based on your homepage';
    err.hidden = true;
    button.disabled = true;
    button.textContent = 'Checking…';
    const stop = startScan(site);
    try {
      const t = await post('/api/free-audit', { url: site, mode: 'teaser' });
      stop();
      render(t);
    } catch (ex) {
      stop();
      out.hidden = true;
      title.textContent = 'AI visibility audit';
      sub.textContent = 'See how visible your brand is to AI assistants, and what to fix.';
      showError(ex instanceof TypeError ? 'We could not reach the audit service. Try again in a moment.' : ex.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Check my AI visibility';
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const site = input.value.trim();
    const ok = validSite(site);
    field.classList.toggle('is-bad', !ok);
    if (!ok) { showError('Enter a valid website, like yourwebsite.com'); input.focus(); return; }
    history.replaceState(null, '', `/ai-visibility?site=${encodeURIComponent(site)}`);
    run(site);
  });
  input.addEventListener('input', () => { field.classList.remove('is-bad'); err.hidden = true; });

  // Arriving with ?site=: start straight away.
  const first = new URLSearchParams(location.search).get('site');
  if (first) {
    input.value = first;
    input.dispatchEvent(new Event('input'));
    if (validSite(first.trim())) run(first.trim());
    else showError('Enter a valid website, like yourwebsite.com');
  }
}
