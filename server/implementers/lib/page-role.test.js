import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePageRole, isInlineRole, layoutRoleFromContract } from './page-role.js';

const site = (root = {}, extra = {}) => ({ url_file_map: { siteRoot: root }, ...extra });

describe('resolvePageRole', () => {
  test('a blog-outline draft is an article body whatever its URL looks like — the reported bug', () => {
    // classifyPageType('/recursos/x') is 'other', which used to mean hero-scale headings.
    for (const permalink of ['/recursos/mi-post/', '/articulos/x/', '/guides-fr/y/']) {
      const r = resolvePageRole(site(), { permalink, actionType: 'blog-outline' });
      assert.equal(r.role, 'inline-article', permalink);
      assert.equal(r.confidence, 'high');
      assert.equal(r.source, 'action-type');
    }
  });

  test('direct-answer and translation are article bodies too; landing-page is a section page', () => {
    assert.equal(resolvePageRole(site(), { actionType: 'direct-answer' }).role, 'inline-article');
    assert.equal(resolvePageRole(site(), { actionType: 'translation' }).role, 'inline-article');
    assert.equal(resolvePageRole(site(), { permalink: '/blog/x/', actionType: 'landing-page' }).role, 'section-page');
  });

  test('explicit tenant config beats the action type', () => {
    const r = resolvePageRole(site({ newContentTargets: { 'blog-outline': { pageRole: 'section-page' } } }), { actionType: 'blog-outline' });
    assert.equal(r.role, 'section-page');
    assert.equal(r.source, 'newContentTargets');
  });

  test('pageRoles by prefix is honoured', () => {
    const r = resolvePageRole(site({ pageRoles: { stories: 'inline-article' } }), { permalink: '/stories/a/' });
    assert.equal(r.role, 'inline-article');
    assert.equal(r.source, 'siteRoot.pageRoles');
  });

  test('an invalid configured role is ignored, not trusted', () => {
    const r = resolvePageRole(site({ pageRoles: { stories: 'banana' } }), { permalink: '/stories/a/' });
    assert.notEqual(r.source, 'siteRoot.pageRoles');
  });

  test('a prefix the regex has never heard of is learned from captured siblings', () => {
    const root = { designProfile: { pages: [
      { url: 'https://x.com/articulos/uno', pageType: 'blog-article' },
      { url: 'https://x.com/articulos/dos', pageType: 'blog-article' },
    ] } };
    const r = resolvePageRole(site(root), { permalink: '/articulos/tres/' });
    assert.equal(r.role, 'inline-article');
    assert.equal(r.source, 'captured-profile');
    assert.equal(r.confidence, 'medium');
  });

  test('captured non-article pages under a prefix make it a section prefix', () => {
    const root = { designProfile: { pages: [{ url: 'https://x.com/servicios/a', pageType: 'service' }] } };
    assert.equal(resolvePageRole(site(root), { permalink: '/servicios/b/' }).role, 'section-page');
  });

  test('with no evidence above it, the regex answers, at low confidence', () => {
    const r = resolvePageRole(site(), { permalink: '/blog/post/' });
    assert.equal(r.role, 'inline-article');
    assert.equal(r.confidence, 'low');
    assert.equal(r.source, 'url-regex');
  });

  test('no evidence anywhere is unknown, never a guess', () => {
    assert.equal(resolvePageRole(site(), { permalink: '/zzz/q/' }).role, 'unknown');
    assert.equal(resolvePageRole(site(), {}).role, 'unknown');
  });

  test('a caller-supplied repo-layout verdict slots in below config and above the profile', () => {
    const r = resolvePageRole(site(), { permalink: '/zzz/q/', layoutRole: 'inline-article' });
    assert.equal(r.source, 'repo-layout');
  });

  test('isInlineRole is true only for inline-article', () => {
    assert.equal(isInlineRole('inline-article'), true);
    assert.equal(isInlineRole('section-page'), false);
    assert.equal(isInlineRole('unknown'), false);
  });
});

describe('layoutRoleFromContract', () => {
  test('a post/article layout declared by the siblings makes the directory an article directory', () => {
    for (const layout of ['layouts/blog-post.njk', 'post', 'article.html', 'BlogLayout/post']) {
      assert.equal(layoutRoleFromContract({ layout, unknown: false }), 'inline-article', layout);
    }
  });
  test('a landing/service layout is a section page', () => {
    assert.equal(layoutRoleFromContract({ layout: 'landing.njk' }), 'section-page');
  });
  test('a layout name every page type shares says nothing, and neither does an unknown contract', () => {
    assert.equal(layoutRoleFromContract({ layout: 'base.njk' }), null);
    assert.equal(layoutRoleFromContract({ layout: null }), null);
    assert.equal(layoutRoleFromContract({ layout: 'blog-post.njk', unknown: true }), null);
    assert.equal(layoutRoleFromContract(null), null);
  });
  test('feeds straight into resolvePageRole as the repo-layout tier', () => {
    const r = resolvePageRole({ url_file_map: { siteRoot: {} } }, { permalink: '/zzz/q/', layoutRole: layoutRoleFromContract({ layout: 'post.njk' }) });
    assert.equal(r.source, 'repo-layout');
    assert.equal(r.role, 'inline-article');
  });
});
