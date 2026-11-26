import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nameTokens, chromeNameMatch, isChromeLikeClass, chromeConfig, CHROME_NAME_TOKENS, CHROME_TAGS } from './chrome-context.js';

describe('what counts as page chrome', () => {
  test('names are split into whole tokens, so a navigation panel is found by what it is called', () => {
    assert.deepEqual(nameTokens('v2-nav-mega v2-mm--types'), ['v2', 'nav', 'mega', 'v2', 'mm', 'types']);
    assert.ok(chromeNameMatch('v2-nav-mega v2-mm v2-mm--types'));
    assert.ok(chromeNameMatch('site-dropdown'));
  });
  test('a token alone that real content uses is NOT chrome: a restaurant "menu" section, a "nav-card"', () => {
    for (const content of ['menu-section', 'menu-item', 'nav-card', 'article-body', 'post-content', 'comment-list', 'megabyte-table']) assert.ok(!chromeNameMatch(content), content);
  });
  test('a recorded heading class is distrusted when it reads like navigation furniture (the wider set)', () => {
    for (const c of ['v2-mm__aside-title', 'nav-mega-title', 'sidebar-heading', 'dropdown-title', 'site-footer-heading']) assert.ok(isChromeLikeClass(c), c);
    for (const c of ['h2', 'post-h2', 'text-2xl font-semibold', 'article-hero__h1', 'v2-h2', 'prose-heading']) assert.ok(!isChromeLikeClass(c), c);
  });
  test('the configuration handed into the browser is a copy of the one definition', () => {
    const cfg = chromeConfig(); assert.deepEqual(cfg.tags, [...CHROME_TAGS]); assert.deepEqual(cfg.tokens, [...CHROME_NAME_TOKENS]);
    cfg.tokens.push('x'); assert.ok(!CHROME_NAME_TOKENS.includes('x'));
  });
});
