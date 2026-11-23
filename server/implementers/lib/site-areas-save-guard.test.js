import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateSiteRepoConfig } from '../../db.js';
import { siteForArea } from './site-areas.js';

const site = { id: 424242, url_file_map: { pages: {}, areas: [{ name: 'a', include: ['/a'], override: { pages: { '/': { file: 'x' } } } }] } };

test('saving a per-area view of the map is refused before anything is written', async () => {
  const view = siteForArea(site, 'a');
  await assert.rejects(updateSiteRepoConfig({ siteId: 424242, urlFileMap: view.url_file_map }), /per-area view/);
});
