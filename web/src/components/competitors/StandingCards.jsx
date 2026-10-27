import Badge from '../Badge.jsx';
import { STATUS } from '../../lib/palette.js';

const fmt = (n) => Number(n).toLocaleString('en-US');

function Card({ title, help, value, unit, color, pill, line, loading }) {
  return (
    <div className="tray-card h-full">
      <div className="px-4 pt-3.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
          {pill}
        </div>
        <p className="text-xs leading-[17px] text-faint mt-0.5">{help}</p>
      </div>
      {loading ? (
        <div className="px-4 py-3 space-y-2"><div className="h-6 w-16 bg-muted rounded-control animate-pulse" /><div className="h-3 w-40 bg-muted rounded-control animate-pulse" /></div>
      ) : (
        <>
          <div className="px-4 pt-2 pb-1 flex items-baseline gap-1.5">
            <span className="text-[26px] font-medium tracking-[-0.02em] tnum" style={{ color: color || 'var(--fg)' }}>{value}</span>
            {unit && <span className="text-sm text-faint">{unit}</span>}
          </div>
          <div className="px-4 pb-3.5 text-[13px] text-text">{line}</div>
        </>
      )}
    </div>
  );
}

// The three numbers about this site itself, each with a plain-words meaning and one line on how it
// compares. Competitor-by-competitor detail is below, on each competitor's own card.
export default function StandingCards({ authority, authorityMeta, ownLinks, view, loading }) {
  const trust = authority?.score;
  const trustPill = trust == null ? null
    : trust >= 70 ? <Badge tone="green">Strong</Badge> : trust >= 40 ? <Badge tone="amber">Room to grow</Badge> : <Badge tone="red">Needs work</Badge>;
  const trustColor = trust == null ? undefined : trust >= 70 ? STATUS.good.color : trust >= 40 ? STATUS.warning.color : STATUS.critical.color;

  const gap = view.largestGap;
  const linksPill = ownLinks == null ? null : gap ? <Badge tone="red">Behind</Badge> : <Badge tone="green">Ahead</Badge>;
  const linksLine = ownLinks == null ? 'Not checked yet. This updates monthly.'
    : gap ? `${gap.domain} has ${ownLinks > 0 ? `${(gap.theirs / ownLinks) >= 10 ? Math.round(gap.theirs / ownLinks) : (gap.theirs / ownLinks).toFixed(1)} times as many` : fmt(gap.theirs)}.`
      : 'You have more than any competitor we track.';

  const contentPill = view.ownScore == null || !view.contentCompared ? null
    : view.contentBeaten * 2 > view.contentCompared ? <Badge tone="green">Ahead</Badge> : view.contentBeaten * 2 < view.contentCompared ? <Badge tone="red">Behind</Badge> : <Badge tone="amber">Level</Badge>;

  return (
    <div className="tray mt-3 md:grid-cols-3 grid gap-3">
      <Card
        title="Trust score" help="How much search engines trust your site, 0 to 100. Higher helps you rank."
        loading={loading} value={trust == null ? '—' : trust} unit={trust == null ? null : '/100'} color={trustColor} pill={trustPill}
        line={trust == null ? (authorityMeta?.hasRun ? 'No score was available yet.' : 'Not checked yet. This updates monthly.')
          : <>{authority.dataSource === 'commoncrawl' && <Badge tone="amber" className="mr-1.5">Estimated</Badge>}{authority.scoreDelta ? `${authority.scoreDelta > 0 ? 'Up' : 'Down'} ${Math.abs(authority.scoreDelta)} point${Math.abs(authority.scoreDelta) === 1 ? '' : 's'} since last check.` : 'Unchanged since last check.'}</>}
      />
      <Card
        title="Sites linking to you" help="Other websites that point to yours. Each one is a vote of confidence."
        loading={loading} value={ownLinks == null ? '—' : fmt(ownLinks)} unit={ownLinks == null ? null : 'sites'}
        color={gap ? STATUS.critical.color : ownLinks != null ? STATUS.good.color : undefined} pill={linksPill} line={linksLine}
      />
      <Card
        title="Helpful content" help="How easy your pages are for Google and AI tools to read and quote."
        loading={loading} value={view.ownScore == null ? '—' : view.ownScore} unit={view.ownScore == null ? null : '%'}
        color={view.ownScore == null ? undefined : view.ownScore >= 70 ? STATUS.good.color : view.ownScore >= 40 ? STATUS.warning.color : STATUS.critical.color}
        pill={contentPill}
        line={view.contentCompared ? `Better than ${view.contentBeaten} of your ${view.contentCompared} competitors.` : 'Not compared with competitors yet.'}
      />
    </div>
  );
}
