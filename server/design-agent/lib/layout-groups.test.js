import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGroupFor, groupSamplePage, groupObservedClass } from './layout-groups.js';

const sec = (role, items = []) => ({ role, textHierarchy: items });
const sub = (classes, style = { textTransform: 'none', letterSpacing: 'normal' }) => ({ role: 'subheading', classes, style });
const profile = {
  layoutGroups: { groups: [
    { id: 'g1', sample: '/blog/post-a', members: ['/blog/post-a', '/blog/post-b', '/de/blog/post-c'] },
    { id: 'g2', sample: '/blog/odd', members: ['/blog/odd'] },
  ] },
  pages: [
    { url: 'https://x.test/blog/post-a', pageType: 'blog-article', sections: [sec('nav', [sub('chrome-h')]), sec('content', [sub('post-h2'), sub('post-h2'), sub('rare-h2'), sub('KICKER', { textTransform: 'uppercase', letterSpacing: '0.2em' })]), sec('footer', [sub('foot-h')])] },
    { url: 'https://x.test/blog/odd', pageType: 'blog-article', sections: [sec('content', [sub('odd-h2')])] },
  ],
};

describe('layout-groups lookup', () => {
  test('finds a page\'s group from a full URL, with or without trailing slash, in any member form', () => {
    assert.equal(layoutGroupFor(profile, 'https://x.test/blog/post-b/').id, 'g1');
    assert.equal(layoutGroupFor(profile, 'https://x.test/de/blog/post-c').id, 'g1');
    assert.equal(layoutGroupFor(profile, 'https://x.test/nowhere'), null);
  });

  test('a /blog/ page built differently gets ITS group\'s class, not the blog-type one', () => {
    assert.equal(groupObservedClass(profile, 'https://x.test/blog/post-b'), 'post-h2');
    assert.equal(groupObservedClass(profile, 'https://x.test/blog/odd'), 'odd-h2');
  });

  test('ignores site chrome and label-styled text; null when there is no grounded answer', () => {
    assert.notEqual(groupObservedClass(profile, 'https://x.test/blog/post-a'), 'chrome-h');
    assert.notEqual(groupObservedClass(profile, 'https://x.test/blog/post-a'), 'KICKER');
    assert.equal(groupObservedClass(profile, 'https://x.test/unknown'), undefined);
    assert.equal(groupObservedClass({}, 'https://x.test/blog/post-a'), undefined);
    assert.equal(groupSamplePage({ layoutGroups: { groups: [{ sample: '/z', members: ['/z'] }] }, pages: [] }, 'https://x.test/z'), null, 'sample not captured -> no answer');
  });

  test('plain subheadings are an exact answer (null), distinct from no evidence (undefined)', () => {
    const plain = { layoutGroups: { groups: [{ sample: '/blog/p', members: ['/blog/p'] }] }, pages: [{ url: 'https://x.test/blog/p', sections: [sec('content', [sub(null), sub(null)])] }] };
    assert.equal(groupObservedClass(plain, 'https://x.test/blog/p'), null);
    assert.equal(groupObservedClass(plain, 'https://x.test/blog/p', 'heading'), undefined, 'role never observed -> no answer');
  });

  test('a captured page outside every group is shown by its own captured layout', () => {
    const solo = { layoutGroups: { groups: [] }, pages: [{ url: 'https://x.test/blog/own', sections: [sec('content', [sub('own-h2')])] }] };
    assert.equal(groupObservedClass(solo, 'https://x.test/blog/own/'), 'own-h2');
  });
});
