// SELF-REPAIR DETECTORS. Pure: one project's facts in, findings out. No database, no network, no other project's data, so tenant isolation is a
// property of the signature (a detector can only see the one site it was handed) and every rule is unit-tested.
//
// A finding is { kind, subject, severity, summary, evidence, proposal, blocker }:
//   evidence   only facts that were read (counts, ids, the quoted refusal text). Nothing estimated.
//   proposal   a repair that is SAFE to apply and that was derived from THIS project's own data, with the steps and what it was derived from.
//              Never applied here: a person applies it through the existing audited path (apply-url-file-map-proposal.js, design review).
//   blocker    what only a person can decide, when no evidence-backed repair exists. A finding has a proposal or a blocker, never neither.
//
// Never copies one client's configuration into another: a proposal is built from facts.site alone.

import { isChromeLikeClass } from '../../design-agent/live-analysis/chrome-context.js';

export const SEVERITY = Object.freeze({ HIGH: 'high', WARNING: 'warning' });
export const STALLED_DAYS = 2; // a design decision / skipped selection older than this is no longer "just today"

const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const daysSince = (iso, now) => (iso ? Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000) : null);
const finding = (kind, subject, severity, summary, { evidence = {}, proposal = null, blocker = null } = {}) => {
  if (!proposal && !blocker) blocker = 'No evidence-backed repair could be derived from this project\'s own data; a person has to decide.';
  return { kind, subject, severity, summary, evidence, proposal, blocker };
};

/** The blog-outline target a project's OWN url patterns already imply (a pattern whose file lives under a blog-like folder), or null. */
export function blogTargetFromOwnPatterns(urlFileMap) {
  for (const p of Array.isArray(urlFileMap?.patterns) ? urlFileMap.patterns : []) {
    const file = String(p?.file || ''); const match = String(p?.match || '');
    if (!/blog|post|article|news|insight|guide|resource/i.test(`${file} ${match}`)) continue;
    const m = file.match(/^(.*)\/\$1(\.[a-z0-9]+)$/i) || file.match(/^(.*)\/\$1\/(index\.[a-z0-9]+)$/i);
    if (!m) continue;
    const dir = m[1];
    const extension = m[2].startsWith('.') ? m[2] : `.${m[2].split('.').pop()}`;
    return { target: { dir, extension }, from: { file: p.file, match: p.match } };
  }
  return null;
}

/** Keys named by the front-matter refusal ("Every existing post in this directory declares "author", "category" ..."), or []. */
export function missingKeysFromRefusal(text) {
  const m = String(text || '').match(/declares ((?:"[^"]+"(?:, )?)+)/);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

/** For each key, the single value EVERY sibling post of this project declares, else null (no unanimous value = a person must choose). */
export function unanimousFrontMatter(keys, posts) {
  const out = {}; const undecided = [];
  const usable = (Array.isArray(posts) ? posts : []).filter((p) => p && typeof p === 'object');
  for (const k of keys) {
    const vals = usable.map((p) => p[k]).filter((v) => v !== undefined && v !== null && v !== '');
    const distinct = [...new Set(vals.map((v) => JSON.stringify(v)))];
    if (usable.length >= 2 && vals.length === usable.length && distinct.length === 1) out[k] = JSON.parse(distinct[0]); else undecided.push(k);
  }
  return { values: out, undecided };
}

/** What the stored design profile says about the article's subheading, and what its captured article body actually contains. Pure; read from the profile only. */
export function headingEvidenceFromProfile(profile) {
  const pattern = profile?.pageTypePatterns?.['blog-article'];
  const entry = Array.isArray(pattern?.textHierarchy) ? pattern.textHierarchy.find((h) => h?.role === 'subheading') : null;
  const headings = (Array.isArray(profile?.pages) ? profile.pages : []).filter((p) => p?.pageType === 'blog-article' && Array.isArray(p.bodyHeadings)).flatMap((p) => p.bodyHeadings);
  return {
    recordedClass: entry?.classes || null,
    observedInBody: entry?.observedInBody,
    bare: entry?.bare === true,
    bodyHeadingCount: headings.length,
    bodyHeadingClasses: headings.map((h) => String(h.classes || '').trim()).filter(Boolean).slice(0, 40),
  };
}

// A recorded class is "used by the body" when the body headings that carry a class carry every class name it lists.
const usedByBody = (recorded, bodyClasses) => {
  const want = String(recorded).split(/\s+/).filter(Boolean);
  return bodyClasses.some((c) => { const have = new Set(c.split(/\s+/)); return want.every((w) => have.has(w)); });
};

export function detectCapabilityFindings(facts, { now = new Date() } = {}) {
  const site = facts?.site; if (!site) return [];
  const map = asObj(site.url_file_map);
  const targets = asObj(map.newContentTargets);
  const blog = asObj(targets['blog-outline']);
  const out = [];
  const hasRepo = Boolean(site.repo_owner && site.repo_name);
  const wantsBlogs = (facts.openBlogRecs || 0) > 0 || (facts.blogDrafts14d || 0) > 0;

  // 1. A project that has blog topics but no blog target to write them to.
  if (hasRepo && wantsBlogs && !blog.dir) {
    const own = blogTargetFromOwnPatterns(map);
    out.push(finding('missing-blog-target', '', SEVERITY.HIGH, `${site.name}: ${facts.openBlogRecs} open blog topic(s) but url_file_map.newContentTargets["blog-outline"] is not set, so no article can be written.`, {
      evidence: { openBlogRecs: facts.openBlogRecs, hasPatterns: Array.isArray(map.patterns) },
      proposal: own ? { action: 'set-url-file-map', safe: true, patch: { path: 'newContentTargets["blog-outline"]', value: own.target }, derivedFrom: own.from,
        steps: ['Back up url_file_map', 'Dry-run the patch', 'Apply for this project only', 'Re-run the site audit'] } : null,
      blocker: own ? null : 'Neither the project\'s own url patterns nor its pages show where its articles live. A person (or the live-site scan) has to name the folder and file type.',
    }));
  }

  // 2. Blog refusals because the site's posts all declare keys the platform has no value for. The platform already derives such a value from the
  //    project's OWN sibling posts (newcontent-contract.js siblingConstants); a finding exists only for keys that derivation could not cover, and
  //    for the refusals recorded BEFORE the derivation was deployed it says so (the repair is the deploy, not a configuration change).
  // The stored refusal text is truncated (a few dozen characters), so the key list is read from the text when it survived and otherwise from the contract
  // the project's own sibling posts imply (facts.requiredKeys). If neither names a key, the finding says the keys are unknown rather than guessing.
  const fmRefusal = (facts.blogRefusals || []).find((t) => /Every existing post in this directory declares/.test(t));
  if (fmRefusal) {
    const parsed = missingKeysFromRefusal(fmRefusal);
    // Keys the generator writes itself (title, date, excerpt ...) are never "missing a default".
    const GENERATOR_OWNED = new Set(['title', 'description', 'excerpt', 'summary', 'date', 'dateModified', 'datePublished', 'publishedAt', 'slug', 'permalink']);
    const keys = (parsed.length ? parsed : (facts.requiredKeys || [])).filter((k) => !GENERATOR_OWNED.has(k));
    const have = asObj(blog.frontMatterDefaults);
    const derived = asObj(facts.siblingConstants);
    const stillMissing = keys.filter((k) => have[k] === undefined);
    const uncovered = stillMissing.filter((k) => derived[k] === undefined);
    if (!keys.length) {
      out.push(finding('front-matter-defaults-missing', 'unknown-keys', SEVERITY.HIGH, `${site.name}: blog articles were refused because every existing post declares a key the platform has no value for, and the stored refusal text is too short to name it.`, {
        evidence: { refusals: (facts.blogRefusals || []).length, siblingPostsRead: facts.siblingsSampled || 0 },
        blocker: 'Run the project\'s next blog attempt (it now states the exact keys) or read its blog folder\'s front matter; the platform will not guess which keys are required.',
      }));
    } else if (stillMissing.length) {
      out.push(finding('front-matter-defaults-missing', stillMissing.join(','), SEVERITY.HIGH, `${site.name}: blog articles were refused because every existing post declares ${stillMissing.map((k) => `"${k}"`).join(', ')} and no default is set.`, {
        evidence: { refusals: (facts.blogRefusals || []).filter((t) => missingKeysFromRefusal(t).length).length, keys: stillMissing, derivedFromOwnPosts: Object.keys(derived).filter((k) => stillMissing.includes(k)), siblingPostsRead: facts.siblingsSampled || 0 },
        proposal: !uncovered.length ? { action: 'deploy-sibling-derivation', safe: true, derivedFrom: `the value this project's own ${facts.siblingsSampled || 'existing'} posts declare (newcontent-contract.js siblingConstants)`,
          steps: ['Deploy the branch: the contract fills these keys from the project\'s own posts', 'Retry the refused blog topics; no configuration change is needed'] } : null,
        blocker: uncovered.length ? `${uncovered.map((k) => `"${k}"`).join(', ')}: the project's own posts do not show one consistent value (or could not be read), so the platform will not invent one. A person must state the value in newContentTargets["blog-outline"].frontMatterDefaults.` : null,
      }));
    }
  }

  // 3. Blog topics waiting on a design decision nobody has made.
  const blogPatterns = (facts.pendingPatterns || []).filter((p) => p.generatorId === 'blog-outline' || p.pageType === 'blog-article');
  for (const p of blogPatterns) {
    const age = daysSince(p.createdAt, now);
    const hasArticleTemplate = Boolean(asObj(asObj(map.siteRoot).pageTemplates)['blog-article']);
    out.push(finding('blog-waiting-on-design-decision', p.pageType || 'blog-article', age >= STALLED_DAYS ? SEVERITY.HIGH : SEVERITY.WARNING,
      `${site.name}: blog drafts are held for a design decision ("${p.pageType || 'blog-article'}" layout) that has been pending ${age ?? '?'} day(s). Every blog attempt waits on it.`, {
        evidence: { proposalId: p.id, pendingDays: age, openBlogRecs: facts.openBlogRecs, skippedBlogItems: facts.skippedBlogItems?.length || 0, siteHasStoredArticleTemplate: hasArticleTemplate },
        proposal: { action: 'rederive-design-profile', safe: true,
          derivedFrom: 'this project\'s own pages: the live-site capture now finds an article for sites that keep their posts at the site root',
          steps: ['Re-derive the design profile for this project only (the capture finds a real article page)', 'The proposal resolves when a "blog-article" pattern is observed', 'If no real article is found, approve or reject the pending layout proposal in Design Review'] },
      }));
  }

  // 4. No blog template and nothing to derive one from.
  const types = asObj(asObj(asObj(map.siteRoot).designProfile).pageTypePatterns);
  const hasArticlePattern = Boolean(types['blog-article']) || Boolean(asObj(asObj(map.siteRoot).pageTemplates)['blog-article']);
  const targetIsDocsFolder = Boolean(blog.dir) && /^docs(\/|$)/i.test(blog.dir) && !blogTargetFromOwnPatterns(map);
  const noArticlePage = (facts.noArticlePageAbandoned || 0) > 0;
  if (hasRepo && wantsBlogs && !blogPatterns.length && (noArticlePage || (!hasArticlePattern && ((!blog.dir && !blogTargetFromOwnPatterns(map)) || targetIsDocsFolder)))) {
    out.push(finding('no-blog-template', '', SEVERITY.HIGH, `${site.name}: the project has blog topics but no blog page, template or target. Articles cannot match a design that does not exist yet.`, {
      evidence: { openBlogRecs: facts.openBlogRecs, abandonedForNoArticlePage: facts.noArticlePageAbandoned || 0, pageTemplates: Object.keys(asObj(asObj(map.siteRoot).pageTemplates)), configuredTarget: blog.dir || null },
      blocker: `A blog template built from this project's own design system needs a design proposal for review before anything is written.${targetIsDocsFolder ? ` The configured target ("${blog.dir}") is a documentation folder, not a blog route, so nothing written there would ever be a page.` : ''}`,
    }));
  }

  // 5. Blog items selected but not started, again and again.
  const skipped = facts.skippedBlogItems || [];
  const days = new Set(skipped.map((s) => s.day));
  if (skipped.length && days.size >= STALLED_DAYS) {
    const reasons = [...new Set(skipped.map((s) => s.skipReason))];
    out.push(finding('blog-selection-stalled', reasons.join(','), SEVERITY.HIGH, `${site.name}: blog items were selected on ${days.size} different days and never started (${reasons.join(', ')}).`, {
      evidence: { skipped: skipped.length, days: days.size, reasons, sample: skipped.slice(0, 3).map((s) => String(s.reason || '').slice(0, 160)) },
      proposal: blogPatterns.length || (facts.blogRefusals || []).length ? { action: 'see-linked-findings', safe: true, steps: ['Resolve the blog-waiting-on-design-decision / front-matter finding for this project; the stalled selection clears on the next pass'] } : null,
      blocker: blogPatterns.length || (facts.blogRefusals || []).length ? null : 'The skip reasons recorded do not point to a configuration gap; inspect the recorded reasons.',
    }));
  }

  // 6. Articles rejected by the render check for measuring differently from the site's real article page. The content is intact; once the renderer or the
  //    measurement is corrected the stored article is rendered again and put through the SAME gate (lib/self-repair/rerender-blog-drafts.js). Never relaxed.
  if ((facts.renderMismatchAbandoned || 0) > 0) {
    out.push(finding('blog-render-mismatch', '', SEVERITY.WARNING, `${site.name}: ${facts.renderMismatchAbandoned} complete article(s) were abandoned because the render check measured them differently from the site's real article page.`, {
      evidence: { abandoned: facts.renderMismatchAbandoned },
      proposal: { action: 'rerender-abandoned-drafts', safe: true, derivedFrom: 'the articles\' own stored content (nothing is rewritten) and this project\'s own live article page',
        steps: ['Render each stored article again with the current renderer', 'Run the unchanged rendering gate on it (never relaxed)', 'Restore only the ones that pass to draft; the rest stay abandoned with the new reason'] },
    }));
  }

  // 7. Keyword discovery that has never produced anything for a project old enough to have it.
  const ageDays = daysSince(site.growth_started_at, now);
  const k = facts.keyword || {};
  if (hasRepo && ageDays !== null && ageDays >= 7 && !k.gaps) {
    out.push(finding('keyword-discovery-missing', '', SEVERITY.HIGH, `${site.name}: no keyword has ever been discovered (${ageDays} days since the project started).`, {
      evidence: { gaps: 0, lastDiscoveryAt: k.lastRunAt || null, recordedReason: k.skipReason || null },
      proposal: k.skipReason ? { action: 'fix-discovery-input', safe: true, steps: [`Resolve the recorded reason: ${k.skipReason}`, 'Run discovery for this project only', 'Never fill gaps with invented volumes: a keyword without real search data keeps its volume empty and says so'] } : null,
      blocker: k.skipReason ? null : 'Discovery has not recorded why it produced nothing for this project; the discovery status must be read before anything can be repaired.',
    }));
  }

  // 8. A discovery path that is recorded as blocked (no service credit, no connection token, ...): stated per path, with the recorded reason. A person acts on
  //    the credit/token; the system does not guess keywords to fill the gap, and a keyword without real search data keeps its volume empty.
  for (const d of k.blockedPaths || []) {
    out.push(finding('keyword-discovery-blocked', d.path, SEVERITY.HIGH, `${site.name}: keyword discovery path "${d.path}" is ${d.status}: ${d.message}`, {
      evidence: { path: d.path, status: d.status, reasonCode: d.reasonCode || null, checkedAt: d.checkedAt || null, otherPaths: (k.paths || []).filter((p) => p.path !== d.path) },
      blocker: `${d.message} (a service credit or connection token is a person's to supply; no search data is invented meanwhile${(k.paths || []).some((p) => p.path !== d.path && p.status === 'ok') ? '; the other discovery path is working' : ''}).`,
    }));
  }
  // 9. The recorded article SUBHEADING class is not one the article body uses (the Zennly shape: a mega-menu panel's <h4 class="v2-mm__aside-title"> recorded as the article's
  //    subheading, while the real headings are bare). The design standard for that client's articles would rest on the wrong element, so it is stated, with the repair.
  const he = facts.headingEvidence;
  if (hasRepo && he?.recordedClass && he.observedInBody !== true) {
    const chromeLike = isChromeLikeClass(he.recordedClass);
    const absentFromBody = he.bodyHeadingCount > 0 && !usedByBody(he.recordedClass, he.bodyHeadingClasses || []);
    if (chromeLike || absentFromBody) {
      out.push(finding('heading-evidence-not-in-body', he.recordedClass, SEVERITY.HIGH,
        `${site.name}: the recorded article subheading class "${he.recordedClass}" is not used by any heading in its article body${chromeLike ? ' and reads like navigation furniture' : ''}; the article's real headings ${he.bodyHeadingCount ? `(${he.bodyHeadingCount} captured) carry no such class` : 'were not captured'}.`, {
          evidence: { recordedClass: he.recordedClass, chromeLike, bodyHeadingCount: he.bodyHeadingCount, bodyHeadingClasses: (he.bodyHeadingClasses || []).slice(0, 5) },
          proposal: { action: 'rederive-design-profile', safe: true, derivedFrom: 'this project\'s own article page, read by the corrected capture (body headings only, navigation excluded)',
            steps: ['Re-derive the design profile for this project only', 'The article subheading is then recorded from the body headings (bare when they carry no class)', 'Until then the guard ignores the untrusted class and holds the article to the page\'s own styling'] },
        }));
    }
  }
  return out;
}
