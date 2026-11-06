import { Navigate } from 'react-router-dom';
import PageIntro from '../components/layout/PageIntro.jsx';
import { useIndustry } from '../lib/industry-state.jsx';

// The Industry page: what is happening in this project's industry and how to grow in it. It exists only once the industry is
// confirmed (two signals agree), and each section appears only when there is real data for it: no placeholders, no
// "coming soon". Numbers are the project's own; key dates and stages are typical for the industry and labelled as such.

const stripDot = (t) => String(t || '').replace(/[.\s]+$/, '');
const Seg = ({ n, of = 4 }) => <div className="ind-sg">{Array.from({ length: of }, (_, i) => <i key={i} className={i < n ? 'f' : ''} />)}</div>;
const Bar = ({ percent }) => <div className="ind-pb"><i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>;
const fmtDate = (d) => { try { return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch { return ''; } };

export function buildHeadline(d) {
  const stage = d.stages?.find((x) => x.state === 'now');
  const next = d.moves?.[0]?.title;
  if (d.strongestArea && stage) return { title: `You are strong on ${d.strongestArea}, and at the “${stage.title}” stage.`, body: next ? `${stage.description} First move: ${stripDot(next)}.` : stage.description };
  if (stage) return { title: `You are at the “${stage.title}” stage in ${d.label.toLowerCase()}.`, body: next ? `${stage.description} First move: ${stripDot(next)}.` : stage.description };
  return { title: `Here is where you stand in ${d.label.toLowerCase()}.`, body: 'The stages below show how businesses like yours grow.' };
}

export default function Industry() {
  const d = useIndustry();
  if (d === null) return <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12"><PageIntro title="Industry" subtitle="Your industry, and how to grow in it." /><div className="tray-card px-4 py-10 text-sm text-faint text-center">Loading…</div></div>;
  if (!d.available) return <Navigate to="/overview" replace />;

  const stageNow = d.stages?.find((s) => s.state === 'now');
  const stageIndex = d.stages ? d.stages.findIndex((s) => s.state === 'now') : -1;
  const head = buildHeadline(d);
  const rows = [
    ['Industry', d.subIndustry ? `${d.label} · ${d.subIndustry.replace(/-/g, ' ')}` : d.label],
    d.strongestArea && ['Strongest area', d.strongestArea],
    d.moves?.[0] && ['First move', d.moves[0].title],
    stageNow && ['Your stage', stageNow.title],
  ].filter(Boolean);
  const stat = (k) => d.stats?.find((s) => s.key === k);
  const demand = stat('demand'); const qs = stat('questions'); const ai = stat('ai');
  const news = d.news || []; const lessons = d.lessons || [];

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageIntro title="Industry" subtitle="Your industry, and how to grow in it." />

      <div className="ind-hero">
        <div className="ind-hero-top">
          <div className="l">
            <div className="k">{d.label}{d.subIndustry ? ` · ${d.subIndustry.replace(/-/g, ' ')}` : ''} · {d.confidence === 'high' ? 'confirmed' : 'detected from your site and searches'}</div>
            <h2>{head.title}</h2>
            <p>{head.body}</p>
          </div>
          <div className="r">
            <small>Built for your site only</small>
            {rows.map(([a, b]) => <div className="row" key={a}><span>{a}</span><b>{b}</b></div>)}
          </div>
        </div>
        <div className="ind-big">
          {d.pagesRead ? <div><b>{d.pagesRead}</b><span>pages read</span></div> : null}
          {demand && demand.value !== null ? <div><b className={demand.value >= 0 ? 'g' : ''}>{demand.value > 0 ? '+' : ''}{demand.value}%</b><span>search impressions vs the previous period</span></div> : null}
          {qs ? <div><b>{qs.percent}%</b><span>of the questions people search are answered <em style={{ fontStyle: 'normal' }}>({qs.done} of {qs.of})</em></span><Bar percent={qs.percent} /></div> : null}
          {ai ? <div><b>{ai.percent}%</b><span>of AI answers name you <em style={{ fontStyle: 'normal' }}>({ai.done} of {ai.of}{ai.asOf ? `, checked ${fmtDate(ai.asOf)}` : ''})</em></span><Bar percent={ai.percent} /></div> : null}
          {stageNow ? <div><b>{stageNow.title}</b><span>your growth stage</span><Seg n={stageIndex + 1} /></div> : null}
        </div>
      </div>

      {d.moves?.length > 0 && (
        <>
          <h3 className="ind-sec">Your {d.moves.length === 1 ? 'best move' : `${d.moves.length} best moves`}<small>Ranked by what we found on your site.</small></h3>
          <div className="ind-mc">
            {d.moves.map((m, i) => (
              <div className="ind-mcard" key={`${m.id}-${i}`}>
                <span className="no">{i + 1}</span>
                <b>{m.title}</b>
                {m.reason && <p>{m.reason}</p>}
                <a className="ind-btn" href={`${import.meta.env.BASE_URL}action-center`}>Open in Action Center</a>
              </div>
            ))}
          </div>
        </>
      )}

      {(d.moving?.length > 0 || d.keyDates?.length > 0) && (
        <div className={`ind-two ${d.moving?.length && d.keyDates?.length ? 'has2' : ''}`} style={{ marginTop: 26 }}>
          {d.moving?.length > 0 && (
            <div>
              <h3 className="ind-sec" style={{ marginTop: 0 }}>What is moving<small>Searches in your topics, this period against the one before.</small></h3>
              <div className="tray"><div className="tray-card" style={{ padding: '8px 18px' }}>
                {(() => { const max = Math.max(...d.moving.map((x) => x.recent), 1); return d.moving.map((x) => (
                  <div className="ind-hb" key={x.topic}>
                    <b>{x.topic}</b>
                    <div className="tr"><i style={{ width: `${Math.max(6, Math.round((x.recent / max) * 100))}%`, background: x.change >= 0 ? 'var(--green)' : '#d9654f' }} /></div>
                    <span className={x.change > 3 ? 'ind-up' : x.change < -3 ? 'ind-dn' : 'ind-fl'}>{x.change > 0 ? '+' : ''}{x.change}%</span>
                  </div>
                )); })()}
              </div></div>
            </div>
          )}
          {d.keyDates?.length > 0 && (
            <div>
              <h3 className="ind-sec" style={{ marginTop: 0 }}>Coming up<small>{d.keyDatesNote || 'Typical for this industry.'}</small></h3>
              <div className="tray"><div className="tray-card">
                {d.keyDates.map((k) => <div className="ind-cal" key={`${k.month}-${k.title}`}><span className="d">{k.month}</span><span><b>{k.title}</b>{k.advice && <p>{k.advice}</p>}</span></div>)}
              </div></div>
            </div>
          )}
        </div>
      )}

      {d.stages?.length === 4 && (
        <>
          <h3 className="ind-sec">Where you are<small>Four stages a {d.label.toLowerCase()} business grows through.</small></h3>
          <div className="tray"><div className="tray-card">
            <div className="ind-stp">
              {d.stages.map((s, i) => (
                <div className={`ind-sp ${s.state}`} key={s.key}>
                  <span className="dot">{s.state === 'done' ? '✓' : i + 1}</span>
                  <b>{s.title}</b><p>{s.description}</p>
                  <span className={`ind-pill ${s.state}`}>{s.state === 'done' ? 'Done' : s.state === 'now' ? 'You are here' : 'Next'}</span>
                </div>
              ))}
            </div>
            {(d.stageNote || d.moves?.[0]) && <div className="ind-nx"><b>Next gain</b>{d.stageNote || d.moves[0].title}</div>}
          </div></div>
        </>
      )}

      {(lessons.length > 0 || news.length > 0) && (
        <details className="ind-more">
          <summary>Also in your industry <span>{[lessons.length ? `${lessons.length} lesson${lessons.length === 1 ? '' : 's'} from other projects` : null, news.length ? `${news.length} news item${news.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}</span></summary>
          {lessons.map((l, i) => <div className="it" key={`${l.claim}-${i}`}><b>{l.claim}</b><span>{l.label}{l.projects ? ` · ${l.projects} projects` : ''}. A hint, not a rule.</span></div>)}
          {news.map((n, i) => <a className="it" key={`${n.url}-${i}`} href={n.url} target="_blank" rel="noreferrer"><b>{n.title}</b><span>{n.source}{n.publishedAt ? ` · ${fmtDate(n.publishedAt)}` : ''}</span></a>)}
        </details>
      )}
    </div>
  );
}
