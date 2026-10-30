import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWeeklyReportHtml } from './weekly-pdf.js';
import { monthWeeks } from './inapp-model.js';

const body = {
  headline: 'Clicks are up 9% on the prior week',
  tiles: [{ label: 'Clicks', value: '1,168', delta: '▲ 9% vs prior week', tone: 'good' }],
  did: [{ title: 'Described your images', did: 'We added descriptions.', why: 'Images can be found.' }],
  sections: [
    { title: 'Day by day', head: ['Day', 'Clicks'], rows: [['Mon 19', '142']] },
    { title: 'Page scores that improved', head: ['Page', 'Change'], rows: [['/a', { t: '▲ +24', tone: 'good' }]] },
  ],
};

test('weekly PDF paints each client in its own colour and escapes names', () => {
  const html = renderWeeklyReportHtml({ site: { name: 'A <b>&</b> Co', brand_color: '#0d1282' }, periodLabel: 'Oct 19 – 25, 2026', body, summary: null });
  assert.match(html, /#0d1282/);
  assert.ok(!html.includes('A <b>'));
  assert.match(html, /Clicks are up 9%/);
  assert.match(html, /color:#15803d/);
});

test('a client with no colour gets the Zunkiree green, not another client\'s', () => {
  assert.match(renderWeeklyReportHtml({ site: { name: 'X' }, periodLabel: 'p', body, summary: null }), /#76b900/);
});

test('monthWeeks splits a month into Mon–Sun weeks clipped to the month', () => {
  const w = monthWeeks('2026-10-01', '2026-10-31');
  assert.deepEqual(w[0], { start: '2026-10-01', end: '2026-10-04' });
  assert.equal(w.at(-1).end, '2026-10-31');
});
