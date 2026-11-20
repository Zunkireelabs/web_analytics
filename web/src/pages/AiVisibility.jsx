import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, timeAgo } from '../api.js';
import PageIntro from '../components/layout/PageIntro.jsx';
import Headline from '../components/ai-visibility/Headline.jsx';
import WordsByPage from '../components/ai-visibility/WordsByPage.jsx';
import { summary as summarize, engineRows, trend as trendOf } from '../lib/ai-visibility-view.js';
import SeenList from '../components/ai-visibility/SeenList.jsx';
import MissingList from '../components/ai-visibility/MissingList.jsx';
import AddPrompt from '../components/ai-visibility/AddPrompt.jsx';
import CrawlersTab from '../components/ai-crawlers/CrawlersTab.jsx';
import SegmentedTabs from '../components/SegmentedTabs.jsx';
import { useSearchParams } from 'react-router-dom';

// AI visibility: how often AI engines name this brand for buyer-style prompts, which prompts they do
// not, and what to add so they would. The SEO / AEO / GEO score row lives on the Agents page, not here.
// Everything below the top strip is real, already-persisted agent output (server/routes/ai-visibility.js).
export default function AiVisibility() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'crawlers' ? 'crawlers' : 'answers';
  const setView = (v) => setParams(v === 'crawlers' ? { view: 'crawlers' } : {}, { replace: true });
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

  const engines = board?.engines || [];
  const byEngine = (rows) => (engine === 'all' ? rows : rows.filter((r) => r.engines.includes(engine)));
  const seen = byEngine(board?.seen || []).map((r) => (engine === 'all' ? r : { ...r, seenOn: r.seenOn.filter((e) => e === engine) }));
  const missing = byEngine(board?.missing || []);

  const toggle = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => setPicked((s) => {
    const open = missing.filter((p) => !p.ship).map((p) => p.id);
    return s.size === open.length ? new Set() : new Set(open);
  });

  // "Draft these": the agent writes the drafts now. They land in Action Center / Content, where the client approves them.
  async function draft(ids) {
    setBusy(true); setMessage(null);
    try {
      const r = await api.aiVisibility.ship(ids, true);
      setPicked(new Set());
      setMessage(`${r.drafted} draft${r.drafted === 1 ? '' : 's'} made${r.failed ? `, ${r.failed} could not be made` : ''}. They are waiting for your approval.`);
      await loadBoard();
    } catch (e) { setMessage(e.message || 'Could not make the drafts.'); } finally { setBusy(false); }
  }

  const addPrompt = async (text) => { await api.aiVisibility.addPrompt(text); await loadBoard(); };
  const loading = board === null;

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageIntro title="AI visibility" subtitle={view === 'crawlers' ? 'Which AI bots read your website' : 'When buyers ask AI about what you sell, are you the answer?'} />
      <div className="mb-3"><SegmentedTabs options={[{ value: 'answers', label: 'Answers' }, { value: 'crawlers', label: 'Crawlers' }]} value={view} onChange={setView} /></div>
      {view === 'crawlers' ? <CrawlersTab /> : <>

      <Headline summary={summarize(board?.seen || [], board?.missing || [])} trend={trendOf(ai?.history)} lastChecked={ccData?.aiRecommendationMeta?.lastRunAt}
        engines={engineRows(engines, board?.seen || [], board?.missing || [])} active={engine} onPick={setEngine} loading={loading} />

      <div className="grid gap-3 lg:grid-cols-2 items-start">
        <SeenList rows={seen} total={seen.length + missing.length} loading={loading} />
        <MissingList rows={missing} picked={picked} onToggle={toggle} onSelectAll={selectAll} onShip={() => draft([...picked])} busy={busy} loading={loading} message={message} />
      </div>

      <div className="mt-3"><WordsByPage words={board?.words || []} loading={loading} onDraft={draft} busy={busy} /></div>
      <div className="mt-3"><AddPrompt suggestions={board?.suggestions || []} onAdd={addPrompt} /></div>
      </>}
    </div>
  );
}
