// Page Fixer (/page-fixer): posts the website to /api/page-fixer (server/routes/free-audit.js, server/free-audit/siteScan.js),
// reads the streamed progress (newline-delimited JSON), then shows the 10 pages with the most issues. The worst three come
// with three fixes each; the other seven are locked rows (the server sends no fixes for them) that point to Start free trial / Book a demo.
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
  const SITE = 'https://superrank.si';
  const validSite = (v) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(v);
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

  function lockIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    Object.entries({ width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }).forEach(([k, v]) => svg.setAttribute(k, v));
    const body = document.createElementNS(NS, 'rect'); Object.entries({ x: 3, y: 7, width: 10, height: 7, rx: 1.6 }).forEach(([k, v]) => body.setAttribute(k, v));
    const shackle = document.createElementNS(NS, 'path'); shackle.setAttribute('d', 'M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7');
    svg.append(body, shackle);
    return svg;
  }

  // Start free trial / Book a demo, the two ways to see the pages that are locked here.
  function ctaButtons(site) {
    const row = el('div', 'pf-row');
    const trial = el('a', 'btn btn--primary', 'Start free trial'); trial.href = `${SITE}/get-started`;
    const demo = el('a', 'btn btn--light', 'Book a demo'); demo.href = `${SITE}/book-demo?website=${encodeURIComponent(site)}&intent=page-fixer`;
    row.append(trial, demo);
    return row;
  }

  function lockedCard(p, i, site) {
    const d = el('details', 'pf-page pf-page--locked');
    const s = el('summary');
    const rank = el('span', 'pf-rank', String(i + 1));
    const t = el('span', 'pf-ptitle');
    t.append(el('b', '', p.title || p.path), el('small', '', p.path));
    const sc = el('span', 'pf-score');
    sc.append(el('b', '', String(p.score)), ringBadge(p.score), `${p.failing} issue${p.failing === 1 ? '' : 's'}`);
    const lock = el('span', 'pf-lock'); lock.append(lockIcon());
    s.append(rank, t, sc, lock);
    const body = el('div', 'pf-lockbody');
    body.append(el('p', '', 'The fixes for this page are in your SuperRank workspace. Start a free trial or book a demo to see them.'), ctaButtons(site));
    d.append(s, body);
    return d;
  }

  function pageCard(p, i, site) {
    if (p.locked) return lockedCard(p, i, site);
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

  function ctaCard(site, lockedCount) {
    const box = el('section', 'pf-card pf-unlock');
    box.append(el('h3', '', lockedCount ? `See the fixes for the other ${lockedCount} page${lockedCount === 1 ? '' : 's'}` : 'Want these fixes shipped for you?'));
    box.append(el('p', '', 'Start a free trial and SuperRank writes every fix in your site\'s own design and sends it for your approval. Or book a demo and we walk you through it.'));
    box.append(ctaButtons(site));
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
      ? `Site average ${s.averageScore}/100 · ${GRADE[g]}. These are the pages with the most to fix, worst first. The fixes for the top three are open below.`
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
      r.pages.forEach((p, i) => list.append(pageCard(p, i, site)));
      wrap.append(list);
    }
    if (r.morePages > 0) {
      wrap.append(el('p', 'pf-more', `${r.morePages} more page${r.morePages === 1 ? '' : 's'} need work too. Start a free trial to see them all.`));
    }
    if (s.pagesFailed > 0) {
      wrap.append(el('p', 'pf-more', `${s.pagesFailed} page${s.pagesFailed === 1 ? '' : 's'} could not be read and ${s.pagesFailed === 1 ? 'was' : 'were'} skipped.`));
    }
    wrap.append(ctaCard(site, r.pages.filter((p) => p.locked).length));
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
