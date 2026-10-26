// Free audit page (/free-audit): posts the domain to /api/free-audit (server/routes/free-audit.js),
// shows a scanning animation, then a verdict, scores, the top issues, one free
// sample fix and an email form that unlocks the full report. See audit-shared.js
// for the common pieces.
import { reduceMotion, el, dashboard, fixBlock } from './audit-shared.js';

const form = document.querySelector('[data-audit-form]');
if (form) {
  const err = document.querySelector('[data-audit-err]');
  const out = document.querySelector('[data-audit-result]');
  const input = form.elements.website;
  const button = form.querySelector('button[type="submit"]');
  const field = input.closest('.audit-form__field');
  const title = document.querySelector('[data-audit-title]');
  const sub = document.querySelector('[data-audit-sub]');
  const validSite = (v) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(v);
  const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

  const SCAN_STEPS = [
    'Fetching your homepage',
    'Reading robots.txt and your sitemap',
    'Checking titles, headings and structured data',
    'Testing whether AI crawlers can get in',
    'Looking for answer-ready content',
    'Scoring your Google and AI visibility',
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
    head.append('Auditing ', el('b', '', site.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')), '…');
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

  // The main call to action: we fix everything. The email also unlocks the saved full report.
  function unlockBlock(t, site) {
    const box = el('div', 'ar-card ar-aside');
    const n = t.counts.failing;
    box.append(el('p', 'ar-eyebrow', 'Your next step'), el('h3', 'ar-aside__title', n > 0 ? `Let us fix ${n === 1 ? 'this issue' : `all ${n} issues`} for you` : 'Let us keep you ahead'));
    box.append(el('p', 'ar-aside__text', 'Our team and the SuperRank agent work through every issue, ship each change for your approval, and track how you climb on Google and in AI answers.'));
    const perks = el('ul', 'ar-perks');
    ['We do the work, you approve every change', 'Your full report, with a fix for each issue', 'See if AI crawlers can read and cite your site'].forEach((t2) => perks.append(el('li', '', t2)));
    box.append(perks);
    const f = el('form', 'audit-unlock');
    f.noValidate = true;
    const email = el('input');
    Object.assign(email, { type: 'email', name: 'email', placeholder: 'you@company.com', autocomplete: 'email', required: true });
    email.setAttribute('aria-label', 'Your email');
    const go = el('button', 'btn btn--primary', 'Get my fix plan');
    go.type = 'submit';
    f.append(email, go);
    const small = el('small', '', 'Free, no spam. This audit covers your homepage; we look at the whole site when we work together.');
    const msg = el('p', 'audit-form__err');
    msg.hidden = true;
    box.append(f, msg, small);

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.hidden = true;
      if (!validEmail(email.value.trim())) { msg.textContent = 'Enter a valid email address.'; msg.hidden = false; email.focus(); return; }
      go.disabled = true; go.textContent = 'Sending…';
      try {
        const res = await post('/api/free-audit/unlock', { id: t.id, email: email.value.trim() });
        box.replaceChildren(el('p', 'ar-eyebrow', 'You’re in'), el('h3', 'ar-aside__title', 'Great, your fix plan is started.'), el('p', 'ar-aside__text', res.emailed ? 'We emailed you the link to your full report. Our team will review your site and follow up.' : 'Your full report is ready. Our team will review your site and follow up.'));
        const row = el('div', 'ar-aside__row');
        const demo = el('a', 'btn btn--primary btn--lg', 'Book a call to start now');
        demo.href = `https://superrank.si/book-demo?website=${encodeURIComponent(site)}&intent=audit`;
        const open = el('a', 'btn btn--light btn--lg', 'Open the full report');
        open.href = res.reportUrl;
        row.append(demo, open);
        box.append(row, el('small', '', 'The report link is private to you and stays active for 30 days.'));
      } catch (ex) {
        msg.textContent = ex.message; msg.hidden = false;
        go.disabled = false; go.textContent = 'Get my fix plan';
      }
    });
    return box;
  }

  function ctaCard(site) {
    const box = el('div', 'ar-card ar-aside ar-aside--dark');
    box.append(el('h3', 'ar-aside__title', 'Prefer to talk it through?'), el('p', 'ar-aside__text', 'Book 30 minutes on your own site. We show you where you are missing from Google and AI answers, and what we would fix first.'));
    const demo = el('a', 'btn btn--primary btn--lg', 'Book a demo');
    demo.href = `https://superrank.si/book-demo?website=${encodeURIComponent(site)}&intent=audit`;
    const trial = el('a', 'ar-aside__link', 'or start a free trial');
    trial.href = '/login';
    box.append(demo, trial);
    return box;
  }

  function render(t, site) {
    const main = el('div', 'ar-res__main');
    main.append(dashboard(t));
    if (t.sampleFix) {
      const fix = el('section', 'ar-card');
      fix.append(el('h4', 'ar-card__title', `A free fix · ${t.sampleFix.checkTitle}`), fixBlock(t.sampleFix));
      main.append(fix);
    }
    const side = el('ar-aside', 'ar-res__side');
    side.append(unlockBlock(t, site), ctaCard(site));
    const grid = el('div', 'ar-res');
    grid.append(main, side);
    out.replaceChildren(grid);
    out.hidden = false;
  }

  async function run(site) {
    // The audited site becomes the page heading.
    title.textContent = site.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    sub.textContent = 'Free website audit · based on your homepage';
    err.hidden = true;
    button.disabled = true;
    button.textContent = 'Auditing…';
    const stop = startScan(site);
    try {
      const t = await post('/api/free-audit', { url: site, mode: 'teaser' });
      stop();
      render(t, site);
    } catch (ex) {
      stop();
      out.hidden = true;
      title.textContent = 'Free website audit';
      sub.textContent = 'See how Google and AI assistants read your site, and what to fix first.';
      showError(ex instanceof TypeError ? 'We could not reach the audit service. Try again in a moment.' : ex.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Get my free audit';
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const site = input.value.trim();
    const ok = validSite(site);
    field.classList.toggle('is-bad', !ok);
    if (!ok) { showError('Enter a valid website, like yourwebsite.com'); input.focus(); return; }
    history.replaceState(null, '', `/audit?site=${encodeURIComponent(site)}`);
    run(site);
  });
  input.addEventListener('input', () => { field.classList.remove('is-bad'); err.hidden = true; });

  // Arriving from the homepage field: start straight away.
  const first = new URLSearchParams(location.search).get('site');
  if (first) {
    input.value = first;
    if (validSite(first.trim())) run(first.trim());
    else showError('Enter a valid website, like yourwebsite.com');
  }
}
