// The popup can ask the same thing twice: the shipping card asks "The PR to stage (#12) is open. Merge it?" while the server's needs-you list
// also carries that PR (so the assistant can act on a typed "go ahead" and the daily reminder can name it). Show it once — as the shipping
// card — whenever the card is asking about it. When no card is asking (a different scope, or the card is snoozed), the list item stays so the
// popup still says something is waiting.
export function itemsForPopup(items = [], ship = null) {
  const cardAsksToMerge = ['fixes', 'content'].some((k) => ship?.[k]?.step === 'merge_stage');
  return cardAsksToMerge ? items.filter((i) => !i.prNumber) : items;
}
