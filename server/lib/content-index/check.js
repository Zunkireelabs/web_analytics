// "Does this already exist, or is it already being made?": the one check every generator and research path asks before drafting.
// PURE over the index entries. A match is a reason, not a silent skip: the caller logs `reason` and writes it to the topic decision log.
import { topicTokens, topicMatch, urlKey, pathKey } from './normalize.js';

// Most telling first: something already in flight is reported before something already live.
const STATE_ORDER = ['in_pr', 'approved', 'draft', 'merged', 'published'];
const STATE_PHRASE = {
  in_pr: 'is already in an open pull request',
  approved: 'is already approved and being shipped',
  draft: 'is already a draft awaiting approval',
  merged: 'was already merged',
  published: 'is already published',
};

/**
 * @param {object} p
 *   topic          the topic text
 *   entries        the content index entries for ONE project
 *   ignoreDraftIds drafts that are this very item (a retry must not match itself)
 *   blogsOnly      default true: only blog entries can duplicate a blog topic
 * @returns {{ ok: boolean, matches: Array, reason: string|null }}
 */
export function checkTopicAgainstIndex({ topic, entries = [], ignoreDraftIds = [], blogsOnly = true } = {}) {
  const tokens = topicTokens(topic);
  if (!tokens.length) return { ok: true, matches: [], reason: null };
  const ignore = new Set(ignoreDraftIds.map(Number));
  const matches = [];
  for (const e of entries) {
    if (blogsOnly && e.kind !== 'blog') continue;
    if (e.draftId != null && ignore.has(Number(e.draftId))) continue;
    const m = topicMatch(tokens, e.tokens || []);
    if (!m.match) continue;
    matches.push({ state: e.state, kind: m.kind, score: m.score, url: e.url, title: e.title, draftId: e.draftId, prUrl: e.prUrl, branchName: e.branchName });
  }
  if (!matches.length) return { ok: true, matches: [], reason: null };
  matches.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.score - a.score);
  const top = matches[0];
  const where = top.prUrl || top.url || (top.draftId != null ? `draft #${top.draftId}` : 'the index');
  return { ok: false, matches, reason: `"${topic}" ${STATE_PHRASE[top.state]} (${top.kind} match with "${(top.title || '').slice(0, 80)}": ${where}).` };
}

/**
 * A path a NEW page would be written to: refused when the index holds that path in any state, i.e. a live page, a draft, an open PR or
 * merged content already owns it. `existingPaths` is an optional Set of repo paths known to exist on the base branch.
 */
export function checkNewPath({ path, urlPath = null, entries = [], existingPaths = null, ignoreDraftIds = [] } = {}) {
  const ignore = new Set(ignoreDraftIds.map(Number));
  const p = String(path || '');
  if (existingPaths && existingPaths.has(p)) return { ok: false, reason: `"${p}" already exists on the base branch; a new page never replaces an existing file.`, owner: { state: 'published' } };
  for (const e of entries) {
    if (e.draftId != null && ignore.has(Number(e.draftId))) continue;
    if (e.filePath && e.filePath === p) return { ok: false, reason: `"${p}" is already claimed by ${e.draftId != null ? `draft #${e.draftId}` : 'another item'} (${e.state}).`, owner: e };
    if (urlPath && e.state === 'published' && urlKey(e.url) && pathKey(e.url) === pathKey(urlPath)) return { ok: false, reason: `the page ${e.url} is already live at that address.`, owner: e };
  }
  return { ok: true, reason: null };
}
