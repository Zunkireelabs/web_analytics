// Turns the site's drafts into what the Content page shows inline: what is waiting on the client, what is on its way, and the
// history of what went live. Pure functions so they are tested without a browser.
const TYPE_LABEL = { 'blog-outline': 'Blog post', 'landing-page': 'Landing page', translation: 'Translation', faq: 'FAQ', 'direct-answer': 'Direct answer', 'expand-content': 'Content update' };
export const contentTypeLabel = (t) => TYPE_LABEL[t] || String(t || '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

const WAITING = new Set(['draft', 'edited', 'submitted_for_approval', 'revision_requested']);
const ON_ITS_WAY = new Set(['approved', 'branch_pushed', 'merged_to_stage', 'pr_opened', 'awaiting_publish']);

// A readable title: the draft's own headline when it has one, else the type and page.
export function draftTitle(d) {
  const c = d?.content || {};
  const own = c.title || c.headline || c.translatedTitle || c.selectedTitle || c.metaTitle;
  if (own) return String(own);
  const page = d?.input?.page || d?.input?.topic || '';
  return `${contentTypeLabel(d?.action_type)}${page ? `: ${page}` : ''}`;
}
export const draftPage = (d) => d?.input?.page || d?.input?.filePath || d?.input?.topic || '';

const day = 86_400_000;
export function waitedDays(d, now = Date.now()) {
  const from = d?.created_at ? new Date(d.created_at).getTime() : null;
  return from ? Math.max(0, Math.floor((now - from) / day)) : 0;
}

export function shape(d, now = Date.now()) {
  return {
    id: d.id, title: draftTitle(d), type: d.action_type, typeLabel: contentTypeLabel(d.action_type), page: draftPage(d), status: d.status,
    waitedDays: waitedDays(d, now), createdAt: d.created_at, approvedAt: d.approved_at || null, wentLiveAt: d.implemented_at || null,
    pr: d.pr_number ? { number: d.pr_number, url: d.pr_url || null, state: d.pr_state || null } : null, branch: d.branch_name || null,
    content: d.content || null, typeId: d.action_type,
  };
}

// To review: waiting on the client first (oldest first), then what is already on its way.
export function reviewLists(drafts, now = Date.now()) {
  const all = (drafts || []);
  const waiting = all.filter((d) => WAITING.has(d.status)).map((d) => shape(d, now)).sort((a, b) => b.waitedDays - a.waitedDays);
  const onItsWay = all.filter((d) => ON_ITS_WAY.has(d.status)).map((d) => shape(d, now)).sort((a, b) => (new Date(b.approvedAt || 0)) - (new Date(a.approvedAt || 0)));
  return { waiting, onItsWay };
}

// Live history: everything that went live, newest first, grouped by month ("November 2026").
export function historyByMonth(drafts, now = Date.now()) {
  const live = (drafts || []).filter((d) => d.status === 'implemented' && d.implemented_at)
    .map((d) => shape(d, now)).sort((a, b) => new Date(b.wentLiveAt) - new Date(a.wentLiveAt));
  const groups = [];
  for (const item of live) {
    const label = new Date(item.wentLiveAt).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(item); else groups.push({ label, items: [item] });
  }
  return { total: live.length, groups };
}

export const filterHistory = (groups, type) => (type === 'all' ? groups : groups.map((g) => ({ ...g, items: g.items.filter((i) => i.type === type) })).filter((g) => g.items.length));
