import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgres://x:x@localhost:1/x';
const { decideIndustry } = await import('./industry-detect.js');

const s = (name, industry, subIndustry = '') => ({ name, industry, subIndustry });

test('two signals agreeing confirm the industry', () => {
  const d = decideIndustry([s('search', 'education', 'study-abroad'), s('profile', 'education'), s('site', null)]);
  assert.equal(d.status, 'confirmed'); assert.equal(d.industry, 'education'); assert.equal(d.subIndustry, 'study-abroad');
  assert.deepEqual(d.agreeing, ['search', 'profile']);
});
test('one signal alone is not enough', () => {
  const d = decideIndustry([s('search', 'education'), s('profile', null), s('site', null)]);
  assert.equal(d.status, 'not-enough-data'); assert.equal(d.industry, null);
});
test('two signals pointing different ways confirm nothing', () => {
  const d = decideIndustry([s('search', 'education'), s('profile', 'healthcare'), s('site', null)]);
  assert.equal(d.status, 'disagree'); assert.equal(d.industry, null);
});
test('two against one: the pair wins', () => {
  const d = decideIndustry([s('search', 'wellness'), s('profile', 'wellness'), s('site', 'technology')]);
  assert.equal(d.status, 'confirmed'); assert.equal(d.industry, 'wellness');
});
test('a tie between two pairs is a disagreement', () => {
  const d = decideIndustry([s('a', 'education'), s('b', 'education'), s('c', 'healthcare'), s('d', 'healthcare')]);
  assert.equal(d.status, 'disagree');
});
test('no signals at all', () => {
  assert.equal(decideIndustry([]).status, 'not-enough-data');
  assert.equal(decideIndustry(undefined).status, 'not-enough-data');
});

test('detectIndustryForSite keeps a human choice and writes a detection with its signals', async () => {
  const { detectIndustryForSite } = await import('./industry-detect.js');
  const writes = [];
  const mk = (rows) => async (sql, params) => {
    if (/FROM site_profiles WHERE site_id/.test(sql) && /industry_source FROM/.test(sql)) return { rows };
    if (/FROM gsc_query_page/.test(sql)) return { rows: [{ query: 'study in canada fees' }, { query: 'study abroad visa' }, { query: 'university admission germany' }] };
    if (/SELECT industry, industry_source, main_topics_json/.test(sql)) return { rows: [{ industry: 'education', industry_source: 'inferred', main_topics_json: '["admissions","universities"]' }] };
    writes.push({ sql, params }); return { rows: [] };
  };
  const kept = await detectIndustryForSite({ id: 1 }, { deps: { query: mk([{ industry: 'wellness', industry_source: 'human' }]) } });
  assert.equal(kept.kept, true); assert.equal(writes.length, 0);

  const done = await detectIndustryForSite({ id: 2 }, { deps: { query: mk([]) } });
  assert.equal(done.applied, true); assert.equal(done.industry, 'education');
  assert.match(writes[0].sql, /industry_source[\s\S]*'detected'/);
  const saved = JSON.parse(writes[0].params[2]); assert.ok(saved.agreeing.length >= 2); assert.ok(saved.signals.length === 3);
});

test('search signal: a stray word cannot outvote the rest of the searches', async () => {
  const { searchSignal } = await import('./industry-detect.js');
  const r = searchSignal(['machine learning', 'flow ai', 'gaas vs saas', 'saas vs gaas', 'software companies in nepal', 'zunkiree labs']);
  assert.equal(r.industry, 'technology');
});
test('search signal: no clear leader means no industry', async () => {
  const { searchSignal } = await import('./industry-detect.js');
  assert.equal(searchSignal(['study abroad', 'university admission', 'dental clinic', 'medical clinic']).industry, null);
  assert.equal(searchSignal(['dental clinic']).industry, null);
  assert.equal(searchSignal([]).industry, null);
});
