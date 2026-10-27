import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, timeAgo } from '../api.js';
import PageIntro from '../components/layout/PageIntro.jsx';
import KpiStrip from '../components/layout/KpiStrip.jsx';
import AiRecommendationCard from '../components/AiRecommendationCard.jsx';
import SeenList from '../components/ai-visibility/SeenList.jsx';
import MissingList from '../components/ai-visibility/MissingList.jsx';
import AddPrompt from '../components/ai-visibility/AddPrompt.jsx';
import WordsToAdd from '../components/ai-visibility/WordsToAdd.jsx';
import { engineLabel } from '../components/ai-visibility/engines.js';

// AI visibility: how often AI engines name this brand for buyer-style prompts, which prompts they do
// not, and what to add so they would. The SEO / AEO / GEO score row lives on the Agents page, not here.
// Everything below the top strip is real, already-persisted agent output (server/routes/ai-visibility.js).
export default function AiVisibility() {
  const [ccData, setCcData] = useState(null); // null = loading
  const [board, setBoard] = useState(null);   // null = loading
  const [engine, setEngine] = useState('all');
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const loadBoard = useCallback(() => api.aiVisibility.board().then(setBoard).catch(() => setBoard({ engines: [], seen: [], missing: [], words: [], suggestions: [], trackedCount: 0 })), []);

  useEffect(() => {
    let cancelled = false;
    api.commandCenter.get().then((d) => { if (!cancelled) setCcData(d); }).catch(() => { if (!cancelled) setCcData({}); });
    loadBoard();
    return () => { cancelled = true; };
  }, [loadBoard]);

  const ai = ccData?.aiRecommendation;
  const strip = useMemo(() => {
    if (!ai) return null;
    const gap = ai.competitorCitationGapPct;
    const spark = (ai.history || []).map((h) => h.pct).filter((v) => v != null);
    return [
      { label: 'AI visibility', value: `${ai.visibilityPct}%`, sub: `seen in ${ai.mentionedCount} of ${ai.promptsChecked} tracked prompts`, spark },
      { label: 'Share of AI voice', value: ai.shareOfAiVoicePct != null ? `${ai.shareOfAiVoicePct}%` : '—', sub: 'of all tracked mentions' },
      { label: 'Competitor citation gap', value: gap == null ? '—' : `${gap > 0 ? '+' : ''}${gap} pt${Math.abs(gap) === 1 ? '' : 's'}`,
        sub: gap == null ? '' : gap > 0 ? 'a competitor leads' : 'you lead every tracked competitor' },
      { label: 'Last checked', value: ccData?.aiRecommendationMeta?.lastRunAt ? timeAgo(ccData.aiRecommendationMeta.lastRunAt) : '—', sub: 'updates monthly' },
    ];
  }, [ai, ccData]);

  const engines = board?.engines || [];
  const byEngine = (rows) => (engine === 'all' ? rows : rows.filter((r) => r.engines.includes(engine)));
  const seen = byEngine(board?.seen || []).map((r) => (engine === 'all' ? r : { ...r, seenOn: r.seenOn.filter((e) => e === engine) }));
  const missing = byEngine(board?.missing || []);

  const toggle = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => setPicked((s) => {
    const open = missing.filter((p) => !p.ship).map((p) => p.id);
    return s.size === open.length ? new Set() : new Set(open);
  });

  async function ship(now) {
    setBusy(true); setMessage(null);
    try {
      const r = await api.aiVisibility.ship([...picked], now);
      setPicked(new Set());
      setMessage(now
        ? `${r.drafted} draft${r.drafted === 1 ? '' : 's'} made${r.failed ? `, ${r.failed} failed` : ''}. They are in Action Center for approval.`
        : `${r.queued} prompt${r.queued === 1 ? '' : 's'} left for the 07:00 run.`);
      await loadBoard();
    } catch (e) { setMessage(e.message || 'Could not ship.'); } finally { setBusy(false); }
  }

  const addPrompt = async (text) => { await api.aiVisibility.addPrompt(text); await loadBoard(); };
  const loading = board === null;

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageIntro title="AI visibility" subtitle="How often AI engines recommend you when buyers ask" />

      {ccData !== null && !ai
        ? <AiRecommendationCard aiRecommendation={null} meta={ccData?.aiRecommendationMeta} loading={false} />
        : <KpiStrip items={strip || []} loading={ccData === null} cols={4} />}

      <div className="flex items-center justify-between gap-2 mt-3 px-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0 max-w-full">
          <span className="text-xs text-faint mr-1 shrink-0">AI engines</span>
          <div className="toggle overflow-x-auto max-w-full" role="tablist">
            <button type="button" role="tab" aria-selected={engine === 'all'} className={engine === 'all' ? 'is-on' : undefined} onClick={() => setEngine('all')}>All engines</button>
            {engines.map((e) => (
              <button key={e.id} type="button" role="tab" aria-selected={engine === e.id} disabled={!e.configured}
                title={e.configured ? undefined : 'Not connected yet'}
                className={engine === e.id ? 'is-on' : undefined} style={e.configured ? undefined : { opacity: 0.55 }}
                onClick={() => setEngine(e.id)}>
                {engineLabel(e.id)}{e.configured ? '' : ' · connect'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-3 mt-2 lg:grid-cols-2 items-start">
        <SeenList rows={seen} total={seen.length + missing.length} loading={loading} />
        <MissingList rows={missing} picked={picked} onToggle={toggle} onSelectAll={selectAll} onShip={ship} busy={busy} loading={loading} message={message} />
      </div>

      <div className="grid gap-3 mt-3 lg:grid-cols-2 items-start">
        <AddPrompt suggestions={board?.suggestions || []} onAdd={addPrompt} />
        <WordsToAdd words={board?.words || []} loading={loading} />
      </div>
    </div>
  );
}
