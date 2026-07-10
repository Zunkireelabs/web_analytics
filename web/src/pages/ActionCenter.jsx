import { useEffect, useState } from 'react';
import { api, daysAgo } from '../api.js';
import PageHeader from '../components/PageHeader.jsx';
import DraftModal from '../components/DraftModal.jsx';

const GENERATOR_LABELS = {
  'meta-title': { label: 'Meta Title & Description', icon: '🏷️' },
  faq: { label: 'FAQ', icon: '❓' },
  schema: { label: 'Schema Markup', icon: '🧩' },
  'internal-links': { label: 'Internal Links', icon: '🔗' },
  'blog-outline': { label: 'Blog Outline', icon: '📝' },
  'landing-page': { label: 'Landing Page', icon: '🚀' },
  translation: { label: 'Translation', icon: '🌐' },
};

function timeAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function ActionCenter() {
  const [tab, setTab] = useState('recommendations'); // 'recommendations' | 'drafts'
  const [recs, setRecs] = useState(null); // null = loading
  const [drafts, setDrafts] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState({ start: daysAgo(7), end: daysAgo(0) });
  const [generatingId, setGeneratingId] = useState(null);
  const [activeDraft, setActiveDraft] = useState(null);
  const [error, setError] = useState(null);

  const loadRecs = () => api.actionCenter.recommendations().then(setRecs).catch(() => setRecs({ items: [], lastAnalyzedAt: {} }));
  const loadDrafts = () => api.actionCenter.drafts().then(setDrafts).catch(() => setDrafts([]));

  useEffect(() => { loadRecs(); }, []);
  useEffect(() => { if (tab === 'drafts') loadDrafts(); }, [tab]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const fresh = await api.actionCenter.refresh(range.start, range.end);
      setRecs(fresh);
    } catch (e) {
      setError(e.message || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const generate = async (item) => {
    setGeneratingId(item.id);
    setError(null);
    try {
      const draft = await api.actionCenter.generate(item.generatorId, item.params, item.source);
      setActiveDraft(draft);
      if (tab === 'drafts') loadDrafts();
    } catch (e) {
      setError(`${item.tag}: ${e.message || 'Generation failed'}`);
    } finally {
      setGeneratingId(null);
    }
  };

  const grouped = (recs?.items || []).reduce((acc, item) => {
    (acc[item.generatorId] ||= []).push(item);
    return acc;
  }, {});

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <PageHeader
        title="Action Center"
        subtitle="Every AI recommendation becomes an editable draft — nothing here ever publishes automatically"
        icon="⚡"
      />

      <div className="flex items-center gap-2 border-b border-slate-100">
        {['recommendations', 'drafts'].map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px transition ${
              tab === t ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}>
            {t === 'recommendations' ? 'Recommendations' : `Drafts${drafts ? ` (${drafts.length})` : ''}`}
          </button>
        ))}
      </div>

      {error && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>}

      {tab === 'recommendations' && (
        <>
          <div className="card p-4 flex flex-wrap items-center gap-3">
            <span className="text-xs text-slate-500">
              Last analyzed: {recs ? Object.entries(recs.lastAnalyzedAt || {}).map(([id, at]) => `${id} ${timeAgo(at)}`).join(' · ') || 'never' : '…'}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <input type="date" value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
                className="text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
              <span className="text-xs text-slate-400">to</span>
              <input type="date" value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
                className="text-xs border border-slate-200 rounded-lg px-2 py-1.5" />
              <button onClick={refresh} disabled={refreshing}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60">
                {refreshing ? 'Refreshing… (~30s)' : 'Refresh Recommendations'}
              </button>
            </div>
          </div>

          {recs === null && <div className="card p-8 text-center text-slate-400">Loading…</div>}
          {recs && recs.items.length === 0 && (
            <div className="card p-8 text-center text-slate-400">
              No recommendations yet — click "Refresh Recommendations" to run a fresh analysis.
            </div>
          )}

          {Object.entries(grouped).map(([generatorId, items]) => (
            <div key={generatorId} className="card overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-50">
                <span>{GENERATOR_LABELS[generatorId]?.icon}</span>
                <h3 className="font-bold text-sm text-slate-900">{GENERATOR_LABELS[generatorId]?.label || generatorId}</h3>
                <span className="text-xs text-slate-400">({items.length})</span>
              </div>
              <div className="divide-y divide-slate-50">
                {items.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">{item.tag}</div>
                      <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">{item.reason}</div>
                      {item.params.page && <div className="text-[10px] text-slate-400 mt-0.5 truncate">{item.params.page}</div>}
                    </div>
                    <button
                      onClick={() => generate(item)}
                      disabled={generatingId === item.id}
                      className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 disabled:opacity-60"
                    >
                      {generatingId === item.id ? 'Generating…' : 'Generate Draft'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {tab === 'drafts' && (
        <>
          {drafts === null && <div className="card p-8 text-center text-slate-400">Loading…</div>}
          {drafts && drafts.length === 0 && <div className="card p-8 text-center text-slate-400">No drafts yet — generate one from the Recommendations tab.</div>}
          {drafts && drafts.length > 0 && (
            <div className="card overflow-hidden divide-y divide-slate-50">
              {drafts.map((d) => (
                <button key={d.id} onClick={() => setActiveDraft(d)}
                  className="w-full flex items-center justify-between gap-3 px-5 py-3 text-left hover:bg-slate-50">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800">
                      {GENERATOR_LABELS[d.action_type]?.icon} {GENERATOR_LABELS[d.action_type]?.label || d.action_type}
                    </div>
                    <div className="text-xs text-slate-500 truncate mt-0.5">{d.input?.page || d.input?.topic || d.input?.market || d.input?.city || ''}</div>
                  </div>
                  <span className={`text-[10px] font-semibold px-2 py-1 rounded-full shrink-0 ${d.status === 'edited' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                    {d.status}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {activeDraft && (
        <DraftModal
          draft={activeDraft}
          onClose={() => setActiveDraft(null)}
          onSaved={(updated) => { setActiveDraft(updated); if (tab === 'drafts') loadDrafts(); }}
          onDeleted={() => { setActiveDraft(null); if (tab === 'drafts') loadDrafts(); }}
        />
      )}
    </div>
  );
}
