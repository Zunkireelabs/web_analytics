import { useState } from 'react';
import { api } from '../api.js';
import { Target, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';

// Split out of AnalystChatPanel so it stays visible in the main column even
// while the chat itself lives behind a collapsed drawer — queuing a keyword
// is a standalone action against the keyword queue, not a chat message, and
// shouldn't require opening the chat to reach.
export default function AnalystGrowKeyword({ clientId, onKeywordQueued }) {
  const [keyword, setKeyword] = useState('');
  const [queueing, setQueueing] = useState(false);
  const [queueResult, setQueueResult] = useState(null);
  const [queueError, setQueueError] = useState(null);

  const queueKeyword = async (e) => {
    e.preventDefault();
    const topic = keyword.trim();
    if (!topic || queueing) return;
    setQueueing(true);
    setQueueError(null);
    setQueueResult(null);
    try {
      const gap = await api.keywords.createGap(clientId, topic);
      setKeyword('');
      setQueueResult({ topic: gap.topic, alreadyQueued: gap.alreadyQueued });
      onKeywordQueued?.();
    } catch (err) {
      setQueueError(err.message || 'Could not add that keyword.');
    } finally {
      setQueueing(false);
    }
  };

  return (
    <div className="an-panel p-5 bg-gradient-to-br from-violet-500/[0.05] to-transparent">
      <div className="flex items-center gap-2.5 mb-3">
        <div className="w-8 h-8 rounded-xl grid place-items-center bg-indigo-500/10 border border-indigo-500/25 text-indigo-600 shrink-0">
          <Target size={15} />
        </div>
        <div>
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Grow for a keyword</h2>
          <p className="text-[11px] font-medium text-slate-500">Tell the agent a topic to target, even without impressions yet</p>
        </div>
      </div>

      <form onSubmit={queueKeyword} className="flex items-center gap-2">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="e.g. best travel insurance"
          maxLength={200}
          disabled={queueing}
          className="an-input flex-1 text-[11px] font-semibold py-2.5"
        />
        <button
          type="submit"
          disabled={queueing || !keyword.trim()}
          className="an-grad-btn text-[11px] font-bold px-3 py-2.5 rounded-xl text-white shrink-0 flex items-center gap-1.5 cursor-pointer"
        >
          {queueing ? <Loader2 size={11} className="animate-spin" /> : null}
          Add
        </button>
      </form>

      {queueResult && (
        <p className="text-[11px] font-semibold text-emerald-700 mt-2 flex items-start gap-1.5">
          <CheckCircle2 size={11} className="shrink-0 mt-0.5" />
          <span>
            {queueResult.alreadyQueued
              ? `"${queueResult.topic}" is already waiting for review under Keyword Discovery.`
              : `"${queueResult.topic}" added under Keyword Discovery — send it to Action Center when you're ready.`}
          </span>
        </p>
      )}
      {queueError && (
        <p className="text-[11px] font-semibold text-rose-600 mt-2 flex items-start gap-1.5">
          <AlertTriangle size={11} className="shrink-0 mt-0.5" />
          <span>{queueError}</span>
        </p>
      )}
      {!queueResult && !queueError && (
        <p className="text-[10px] font-medium text-slate-400 mt-2">
          Queued for your review first — nothing is published until you send it to Action Center.
        </p>
      )}
    </div>
  );
}
