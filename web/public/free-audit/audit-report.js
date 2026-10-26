// Saved audit report (/report?id=...): the full list of issues with a
// ready-to-paste fix for each, loaded from the audit service by private id.
import { el, dashboard, hostOf } from './audit-shared.js';

const root = document.querySelector('[data-report]');
if (root) {
  const id = new URLSearchParams(location.search).get('id') || '';
  const state = (title, text) => {
    root.replaceChildren(el('h1', '', title), el('p', 'report__sub', text));
    const a = el('a', 'btn btn--primary', 'Run a new free audit');
    a.href = 'https://superrank.si/';
    root.append(a);
  };

  (async () => {
    if (!/^[a-f0-9]{32}$/.test(id)) return state('Report not found', 'This link looks incomplete. Run a new audit to get a fresh report.');
    try {
      const res = await fetch(`/api/free-audit/report/${id}`);
      if (res.status === 404) return state('This report has expired', 'Reports stay available for 30 days. Run a new audit to get a fresh one.');
      if (!res.ok) throw new Error();
      const r = await res.json();

      root.replaceChildren();
      const main = el('div', 'ar-res__main');
      main.append(dashboard(r));
      const side = el('ar-aside', 'ar-res__side');
      const cta = el('div', 'ar-card ar-aside ar-aside--dark');
      cta.append(el('h3', 'ar-aside__title', 'Let us fix all of this for you'), el('p', 'ar-aside__text', 'Our team and the SuperRank agent work through every issue, ship each change for your approval, and track how you climb on Google and in AI answers.'));
      const demo = el('a', 'btn btn--primary btn--lg', 'Book a call to start');
      demo.href = `https://superrank.si/book-demo?website=${encodeURIComponent(r.finalUrl)}&intent=audit`;
      const trial = el('a', 'ar-aside__link', 'or start a free trial');
      trial.href = '/login';
      cta.append(demo, trial, el('small', '', 'This audit covers your homepage; we look at the whole site when we work together.'));
      side.append(cta);
      const grid = el('div', 'ar-res');
      grid.append(main, side);

      const head = el('div', 'audit-page__head');
      head.append(el('p', 'ar-eyebrow', 'Your SuperRank audit'), el('h1', '', hostOf(r.finalUrl)));
      root.replaceChildren(head, el('div', 'frame', ''));
      root.querySelector('.frame').append(grid);
    } catch {
      state('We could not load this report', 'Please try again in a moment.');
    }
  })();
}
