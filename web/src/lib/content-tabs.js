// The Content page's three steps, in the order content moves: Ideas (pick what the agent writes), Drafted (read what it wrote and
// approve it), History (what was approved and went live). `page` is which screen is showing ('studio' = the idea picker, 'drafts' = the review/history
// screen); `draftsTab` is that screen's own tab ('drafts' | 'implemented' | 'recommendations').
export const CONTENT_TABS = [
  { id: 'ideas', label: 'Ideas', to: '/content' },
  { id: 'review', label: 'Drafted', to: '/content?view=review' },
  { id: 'history', label: 'History', to: '/content?view=history' },
];

// The tab named by ?view= on the Content page (anything unknown is Ideas).
export const viewFromParam = (v) => (v === 'review' || v === 'history' ? v : 'ideas');

export function contentTabFor(page, draftsTab) {
  if (page === 'studio') return 'ideas';
  if (draftsTab === 'implemented') return 'history';
  if (draftsTab === 'drafts') return 'review';
  return null;
}

// Which of ActionCenter's own tabs to open first. The content screen opens on the drafts to review, not the older idea list.
export const DRAFTS_TABS = ['recommendations', 'drafts', 'implemented'];
export function initialDraftsTab(requested, isContent) {
  if (DRAFTS_TABS.includes(requested)) return requested;
  return isContent ? 'drafts' : 'recommendations';
}
