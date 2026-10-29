// Page Fixer (/page-fixer): posts the website to /api/page-fixer (server/routes/free-audit.js, server/free-audit/siteScan.js),
// reads the streamed progress (newline-delimited JSON), then shows the 5 pages with the most issues, each with three fixes.
// The email form reuses the free audit unlock (/api/free-audit/unlock) for the full report of the entered page.
import { reduceMotion, el, gradeOf, fixBlock } from '/free-audit/audit-shared.js';

const form = document.querySelector('[data-pf-form]');
if (form) {
  const err = document.querySelector('[data-pf-err]');
  const out = document.querySelector('[data-pf-out]');
  const input = form.elements.website;
  const button = form.querySelector('button[type="submit"]');
  const field = input.closest('.audit-form__field');
  const fav = form.querySelector('.pf-fav');
  const globe = form.querySelector('.pf-globe');
  const BTN = 'Fix my pages';
  const validSite = (v) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(v);
  const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  const hostOf = (v) => { try { return new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).hostname; } catch { return ''; } };
  const showError = (msg) => { err.textContent = msg; err.hidden = false; };
  const GRADE = { a: 'Excellent', b: 'Good', c: 'Fair', d: 'Needs work', f: 'Critical gaps' };

  // The typed site's own favicon in place of the globe (loaded straight from the site; the globe stays if it has none).
  let favTimer;
  const setFav = (v) => {
    clearTimeout(favTimer);
    favTimer = setTimeout(() => {
      const h = validSite(v.trim()) ? hostOf(v.trim()) : '';
      const reset = () => { fav.hidden = true; globe.style.display = ''; };
      if (!h) return reset();
      fav.onload = () => { fav.hidden = false; globe.style.display = 'none'; };
      fav.onerror = reset;
      fav.src = `https://${h}/favicon.ico`;
    }, 350);
  };

  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
    return data;
  }

  // Reads the NDJSON stream, calling onEvent for each line. Returns when the stream ends.
  async function scan(site, onEvent) {
    const res = await fetch('/api/page-fixer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: site }) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || 'Something went wrong. Please try again.');
    }
    if (!res.body || !res.body.getReader) { // very old browsers: no streaming, take the final result only
      const text = await res.text();
      text.split('\n').filter(Boolean).forEach((l) => onEvent(JSON.parse(l)));
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    if (buf.trim()) onEvent(JSON.parse(buf.trim()));
  }

  // ---------- progress ----------
  function progressView(site) {
    const card = el('section', 'pf-card pf-prog');
    card.append(el('p', 'pf-eyebrow', 'Scanning'));
    const h = el('h2');
    const bar = el('div', 'pf-bar'); const fill = el('i'); bar.append(fill);
    const list = el('ul', 'pf-pages');
    card.append(h, bar, list);
    const rows = new Map();
    const host = site.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const title = (t, b) => { h.replaceChildren(t); if (b) { const x = el('b', '', b); h.append(x); } };
    title('Finding the pages on ', host);
    return {
      node: card,
      pages(ev) {
        title(`Found ${ev.found} page${ev.found === 1 ? '' : 's'}. Checking ${ev.total}`);
        list.replaceChildren();
        ev.pages.forEach((u) => {
          const li = el('li'); li.append(el('span', '', pathOf(u)));
          list.append(li); rows.set(u, li);
        });
        fill.style.width = '10%';
      },
      auditing(ev) { const li = rows.get(ev.url); if (li) li.className = 'is-now'; },
      audit(ev) {
        const li = rows.get(ev.url); if (li) li.className = ev.ok ? 'is-done' : 'is-fail';
        title(`Checking page ${Math.min(ev.done + 1, ev.total)} of ${ev.total}`);
        fill.style.width = `${10 + (ev.done / ev.total) * 88}%`;
      },
    };
  }
  const pathOf = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return u; } };

  // ---------- results ----------
  function ringBadge(score) {
    const g = gradeOf(score);
    return el('span', `ar-grade ar-grade--${g}`, `${g.toUpperCase()}`);
  }

  function fixRow(issue, open) {
    const d = el('details', 'pf-fix'); d.open = open;
    const s = el('summary');
    const t = el('span', 'pf-fix__t');
    t.append(el('b', '', issue.fix?.title || issue.title), el('small', '', issue.message));
    s.append(t, el('span', `pf-sev pf-sev--${issue.severity.toLowerCase()}`, issue.severity), el('i', 'pf-chev'));
    const body = el('div', 'pf-fix__body');
    if (issue.recommendation) body.append(el('p', '', issue.recommendation));
    if (issue.fix) body.append(fixBlock(issue.fix, 'Paste this'));
    d.append(s, body);
    return d;
  }

  function pageCard(p, i) {
    const d = el('details', 'pf-page'); d.open = i === 0;
    const s = el('summary');
    s.append(el('span', 'pf-rank', String(i + 1)));
    const t = el('span', 'pf-ptitle');
    t.append(el('b', '', p.title || p.path), el('small', '', p.path));
    const sc = el('span', 'pf-score');
    sc.append(el('b', '', String(p.score)), ringBadge(p.score), `${p.failing} issue${p.failing === 1 ? '' : 's'}`);
    s.append(t, sc, el('i', 'pf-chev'));
    const fixes = el('div', 'pf-fixes');
    p.issues.forEach((iss, k) => fixes.append(fixRow(iss, i === 0 && k === 0)));
    d.append(s, fixes);
    return d;
  }

  function unlockCard(r, site) {
    const box = el('section', 'pf-card pf-unlock');
    box.append(el('p', 'pf-eyebrow', 'Everything else'));
    box.append(el('h3', '', 'Get the full report with a fix for every issue'));
    box.append(el('p', '', 'We email you a private link to the complete report for your page. We can also ship each change for your approval.'));
    const f = el('form'); f.noValidate = true;
    const email = el('input'); Object.assign(email, { type: 'email', name: 'email', placeholder: 'you@company.com', autocomplete: 'email', required: true });
    email.setAttribute('aria-label', 'Your email');
    const go = el('button', 'btn btn--primary', 'Send me the report'); go.type = 'submit';
    f.append(email, go);
    const msg = el('p', 'audit-form__err'); msg.hidden = true;
    box.append(f, msg, el('small', '', 'Free, no spam. The report link stays private to you.'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); msg.hidden = true;
      if (!r.id) { msg.textContent = 'The full report is not available for this scan. Please run it again.'; msg.hidden = false; return; }
      if (!validEmail(email.value.trim())) { msg.textContent = 'Enter a valid email address.'; msg.hidden = false; email.focus(); return; }
      go.disabled = true; go.textContent = 'Sending…';
      try {
        const res = await post('/api/free-audit/unlock', { id: r.id, email: email.value.trim() });
        box.replaceChildren(el('p', 'pf-eyebrow', 'You are in'), el('h3', '', 'Your full report is on its way.'), el('p', '', res.emailed ? 'We emailed you the link. You can also open it now.' : 'Open your full report now. The link is private to you.'));
        const row = el('div', 'pf-row');
        const open = el('a', 'btn btn--primary', 'Open the full report'); open.href = res.reportUrl;
        const demo = el('a', 'btn btn--light', 'Book a call'); demo.href = `https://superrank.si/book-demo?website=${encodeURIComponent(site)}&intent=audit`;
        row.append(open, demo); box.append(row);
      } catch (ex) { msg.textContent = ex.message; msg.hidden = false; go.disabled = false; go.textContent = 'Send me the report'; }
    });
    return box;
  }

  function resultView(r, site) {
    const wrap = document.createDocumentFragment();
    const s = r.site;
    const sum = el('section', 'pf-card');
    const who = el('div', 'pf-who');
    if (!fav.hidden) { const ic = el('img'); ic.src = fav.src; ic.alt = ''; who.append(ic); }
    who.append(el('b', '', s.host));
    const body = el('div', 'pf-sum');
    const g = gradeOf(s.averageScore);
    const left = el('div'); left.append(ringBadge(s.averageScore));
    const right = el('div');
    right.append(el('h2', '', r.pages.length
      ? `${r.pages.length === 1 ? 'One page needs' : `${r.pages.length} pages need`} your attention first.`
      : 'No page needs fixing.'));
    right.append(el('p', '', r.pages.length
      ? `Site average ${s.averageScore}/100 · ${GRADE[g]}. These are the pages with the most to fix, worst first.`
      : 'Every page we checked passes our checks.'));
    const stats = el('div', 'pf-stats');
    const stat = (n, label) => { const x = el('span'); x.append(el('b', '', String(n)), ` ${label}`); return x; };
    stats.append(stat(s.pagesAudited, `page${s.pagesAudited === 1 ? '' : 's'} checked`), stat(s.pagesWithIssues, 'with issues'), stat(s.pagesFound, 'found'));
    right.append(stats);
    body.append(left, right);
    sum.append(who, body);
    wrap.append(sum);

    if (r.pages.length) {
      const list = el('div', 'pf-list');
      r.pages.forEach((p, i) => list.append(pageCard(p, i)));
      wrap.append(list);
    }
    if (r.morePages > 0) {
      wrap.append(el('p', 'pf-more', `${r.morePages} more page${r.morePages === 1 ? '' : 's'} need work too. They are in your full report.`));
    }
    if (s.pagesFailed > 0) {
      wrap.append(el('p', 'pf-more', `${s.pagesFailed} page${s.pagesFailed === 1 ? '' : 's'} could not be read and ${s.pagesFailed === 1 ? 'was' : 'were'} skipped.`));
    }
    wrap.append(unlockCard(r, site));
    return wrap;
  }

  async function run(site) {
    err.hidden = true; button.disabled = true; button.textContent = 'Scanning…';
    out.hidden = false;
    const view = progressView(site);
    out.replaceChildren(view.node);
    let result = null; let failure = null;
    try {
      await scan(site, (ev) => {
        if (ev.type === 'pages') view.pages(ev);
        else if (ev.type === 'auditing') view.auditing(ev);
        else if (ev.type === 'audit') view.audit(ev);
        else if (ev.type === 'done') result = ev.result;
        else if (ev.type === 'error') failure = ev.message;
      });
      if (failure) throw new Error(failure);
      if (!result) throw new Error('The scan ended early. Please try again.');
      const v = resultView(result, site);
      out.replaceChildren(v);
      out.firstElementChild?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    } catch (ex) {
      out.hidden = true; out.replaceChildren();
      showError(ex instanceof TypeError ? 'We could not reach the Page Fixer. Try again in a moment.' : ex.message);
    } finally {
      button.disabled = false; button.textContent = BTN;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const site = input.value.trim();
    const ok = validSite(site);
    field.classList.toggle('is-bad', !ok);
    if (!ok) { showError('Enter a valid website, like yourwebsite.com'); input.focus(); return; }
    history.replaceState(null, '', `${location.pathname}?site=${encodeURIComponent(site)}`);
    run(site);
  });
  input.addEventListener('input', () => { field.classList.remove('is-bad'); err.hidden = true; setFav(input.value); });

  // The marketing site's "Check page" box links here with ?site=
  const first = new URLSearchParams(location.search).get('site');
  if (first) {
    input.value = first; setFav(first);
    if (validSite(first.trim())) run(first.trim());
    else showError('Enter a valid website, like yourwebsite.com');
  }
}
