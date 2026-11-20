// How many rows a list card shows before "Show all". Kept apart from the component so it can be tested without a browser.
export const DEFAULT_ROW_LIMIT = 6;
export const visibleRows = (rows, limit, expanded) => (expanded || rows.length <= limit ? rows : rows.slice(0, limit));
