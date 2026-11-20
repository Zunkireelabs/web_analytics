// When the assistant brings up something that needs a person, and when it brings it up again. The server says what is
// waiting (get_needs_you); this decides what to raise on THIS visit. Remembered per browser and per project in
// localStorage for now, so another device may raise the same item once more. An item that is resolved drops out of
// the server list and is forgotten here. Interval: 1 day after the first time, then 3, then 7; anything that blocks
// shipping is raised on every visit.
const DAY = 86_400_000;
const KEY = (siteId) => `needs-you-raised:${siteId}`;

export function shouldRaiseAgain(item, { timesRaised = 0, lastRaisedAt = null } = {}, now = Date.now()) {
  if (!lastRaisedAt || timesRaised === 0) return true;
  if (item.blocksShipping) return true;
  const waitDays = timesRaised <= 1 ? 1 : timesRaised === 2 ? 3 : 7;
  return now - new Date(lastRaisedAt).getTime() >= waitDays * DAY;
}

// Which of `items` to raise now, given the memory { [itemKey]: { timesRaised, lastRaisedAt } }.
export function pickItemsToRaise(items, memory = {}, now = Date.now()) {
  return (items || []).filter((i) => shouldRaiseAgain(i, memory[i.key], now));
}

// The memory after raising `raised` now, keeping only items that are still waiting (resolved ones are forgotten).
export function rememberRaised(items, raised, memory = {}, now = Date.now()) {
  const next = {};
  for (const i of items || []) if (memory[i.key]) next[i.key] = memory[i.key];
  for (const i of raised) next[i.key] = { timesRaised: (memory[i.key]?.timesRaised || 0) + 1, lastRaisedAt: new Date(now).toISOString() };
  return next;
}

export function loadMemory(siteId, storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(KEY(siteId))) || {}; } catch { return {}; }
}
export function saveMemory(siteId, memory, storage = globalThis.localStorage) {
  try { storage.setItem(KEY(siteId), JSON.stringify(memory)); } catch { /* private mode: it just asks again next time */ }
}
