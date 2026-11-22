// The small line at the very top of the agent popup: what is left for the client, in one sentence. Worked out from the same things the
// popup shows below it (the "needs you" items and the shipping question), so it can never say something the cards do not.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const join = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || '');

export function greeting(items = [], ship = null) {
  const approvals = (key) => items.filter((i) => i.key === key).reduce((n, i) => n + (i.count || 1), 0);
  const fixes = approvals('approval:fixes');
  const content = approvals('approval:content');
  const main = items.filter((i) => String(i.key).startsWith('approval:main')).length;
  const parts = [fixes && plural(fixes, 'fix', 'fixes'), content && plural(content, 'piece of content', 'pieces of content'), main && plural(main, 'change ready to go live', 'changes ready to go live')].filter(Boolean);
  const total = fixes + content + main;
  // Things left waiting for days are said first and plainly: the bubble is the one place a person sees it without opening anything.
  const overdue = items.filter((i) => i.overdue);
  const days = overdue.length ? Math.max(...overdue.map((i) => i.ageDays || 0)) : 0;
  if (overdue.length) return `Hey, ${plural(overdue.length, 'thing has', 'things have')} been waiting for your OK for ${days} days. Open me and say "go ahead" or tell me what to change.`;
  if (parts.length) return `Hey, ${join(parts)} ${total === 1 ? 'is' : 'are'} left for your approval.`;

  const asks = ship ? ['fixes', 'content'].filter((k) => ship[k]?.step && ship[k].step !== 'waiting').length : 0;
  if (asks) return 'Hey, everything is approved. One step is left before it goes live.';

  const other = items.filter((i) => !String(i.key).startsWith('approval:')).reduce((n, i) => n + (i.count || 1), 0);
  if (other) return `Hey, ${plural(other, 'thing needs', 'things need')} your attention.`;

  const waiting = ship && ['fixes', 'content'].some((k) => ship[k]?.step === 'waiting');
  if (waiting) return 'Hey, a pull request is waiting for someone to merge it on GitHub.';
  return null;
}
