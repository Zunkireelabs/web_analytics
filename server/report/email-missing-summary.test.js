import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailySummaryHtml, MISSING_SUMMARY_TEXT } from './email.js';

test('a missing narrative says so instead of leaving a blank paragraph', () => {
  assert.ok(dailySummaryHtml('').includes(MISSING_SUMMARY_TEXT));
  assert.ok(dailySummaryHtml(null).includes(MISSING_SUMMARY_TEXT));
  assert.ok(dailySummaryHtml('   ').includes(MISSING_SUMMARY_TEXT));
});
test('a real narrative is shown with line breaks, and HTML in it is escaped', () => {
  assert.equal(dailySummaryHtml('Clicks rose.\nImpressions fell.'), 'Clicks rose.<br>Impressions fell.');
  assert.equal(dailySummaryHtml('<b>x</b> & y'), '&lt;b&gt;x&lt;/b&gt; &amp; y');
});
