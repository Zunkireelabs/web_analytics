// How a site's daily fixes reach its repository (sites.ship_mode, migration 259).
//   auto          the daily run drafts, approves and pushes; a person merges the PR.
//   review-first  the daily run only drafts. The client reviews and approves in the dashboard, and only then does anything get
//                 committed or pushed (lib/ship-flow.js asks at each step).
export const SHIP_MODES = Object.freeze({ AUTO: 'auto', REVIEW_FIRST: 'review-first' });

export const isReviewFirst = (site) => site?.ship_mode === SHIP_MODES.REVIEW_FIRST;
