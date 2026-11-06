// What to actually ask once a token is connected.
//
// The connect command has existed for a while and the research tools now exist too, but nothing ever said what they
// can do — so the tools were reachable and unknown, which is the same as missing. These are real questions that map
// onto real tools, written the way someone would type them.
//
// Paid questions are marked, and the list says which tier they need, because a View-only token genuinely cannot run
// them and a person who asks and gets nothing deserves to know why rather than assume it is broken.

const FREE = [
  { ask: 'How did search traffic move last month?', note: 'Clicks, impressions and position from Search Console.' },
  { ask: 'Who are our business competitors?', note: 'Real rivals, separated from directories and publishers.' },
  { ask: 'What keywords do our competitors rank for that we do not?', note: 'From the last collected footprint.' },
  { ask: 'What should we work on next?', note: 'Scored opportunities, each with what to do and why.' },
  { ask: 'Are our tracked keywords moving?', note: 'Position now versus the previous check.' },
  { ask: 'Where are we losing visitors?', note: 'Needs PostHog connected.' },
  { ask: 'What have we spent on data providers this month?', note: 'Always worth asking before the paid questions.' },
];

const PAID = [
  { ask: 'Research the market and find who competes with us', note: 'One live provider call.' },
  { ask: 'What does rival.com rank for?', note: 'One live call, filtered to what we actually sell.' },
  { ask: 'Which of rival.com\'s pages get their traffic?', note: 'One live call.' },
  { ask: 'Start tracking "teeth whitening cost"', note: 'Free to add; each tracked keyword is checked on a schedule.' },
];

export default function WhatYouCanAsk({ tier = 'read_only', className = '' }) {
  const canSpend = tier === 'automation' || tier === 'admin';

  return (
    <div className={`rounded-card border border-line bg-[#fafafa] px-4 py-3 ${className}`}>
      <div className="text-[13px] font-medium">What you can ask</div>
      <p className="mt-1 text-xs text-faint">
        Type these to Claude once the token is connected. It picks the right tool itself.
      </p>

      <ul className="mt-2 space-y-1.5">
        {FREE.map((q) => (
          <li key={q.ask} className="text-[13px] leading-snug">
            <span className="text-fg">“{q.ask}”</span>
            <span className="block text-xs text-faint">{q.note}</span>
          </li>
        ))}
      </ul>

      <div className="mt-3 pt-3 border-t border-line">
        <div className="text-[13px] font-medium">
          Questions that cost money
          {!canSpend && <span className="font-normal text-faint"> · needs an “Open pull requests” token</span>}
        </div>
        <p className="mt-1 text-xs text-faint">
          These call a paid data provider. Each answer reports what it cost, and a project over its monthly budget is
          refused rather than billed.
        </p>
        <ul className={`mt-2 space-y-1.5 ${canSpend ? '' : 'opacity-60'}`}>
          {PAID.map((q) => (
            <li key={q.ask} className="text-[13px] leading-snug">
              <span className="text-fg">“{q.ask}”</span>
              <span className="block text-xs text-faint">{q.note}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
