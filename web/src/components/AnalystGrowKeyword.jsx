import { useState } from 'react';
import { api } from '../api.js';
import { Target, Loader2, CheckCircle2, AlertTriangle, PenLine } from 'lucide-react';

// Split out of AnalystChatPanel so it stays visible in the main column even
// while the chat itself lives behind a collapsed drawer — queuing a keyword
// is a standalone action against the keyword queue, not a chat message, and
// shouldn't require opening the chat to reach.
export default function AnalystGrowKeyword({ clientId, onKeywordQueued }) {
  const [keyword, setKeyword] = useState('');
  const [queueing, setQueueing] = useState(false);
  const [queueResult, setQueueResult] = useState(null);
  const [queueError, setQueueError] = useState(null);
  // 'asking' | 'requesting' | 'requested' | 'declined' — the "write a blog on
  // this?" follow-up, shown only for a keyword this submit actually queued.
  const [blogPrompt, setBlogPrompt] = useState(null);
  const [blogError, setBlogError] = useState(null);

  const queueKeyword = async (e) => {
    e.preventDefault();
    const topic = keyword.trim();
    if (!topic || queueing) return;
    setQueueing(true);
    setQueueError(null);
    setQueueResult(null);
    setBlogPrompt(null);
    setBlogError(null);
    try {
      const gap = await api.keywords.createGap(clientId, topic);
      setKeyword('');
      setQueueResult({ topic: gap.topic, alreadyQueued: gap.alreadyQueued, gapId: gap.id });
      // Only offer the blog for a gap still awaiting review. An already-queued
      // topic may already have its blog requested, and re-approving it here
      // would say "queued for tomorrow" about work that could be days old.
      if (gap.id && !gap.alreadyQueued) setBlogPrompt('asking');
      onKeywordQueued?.();
    } catch (err) {
      setQueueError(err.message || 'Could not add that keyword.');
    } finally {
      setQueueing(false);
    }
  };

  const requestBlog = async () => {
    if (!queueResult?.gapId || blogPrompt === 'requesting') return;
    setBlogPrompt('requesting');
    setBlogError(null);
    try {
      const { actionCenter } = await api.keywords.requestBlogForGap(clientId, queueResult.gapId);
      // Only claim tomorrow's run when the recommendation actually reached the
      // state that run picks up. A blocked one (e.g. this site has nowhere
      // configured to put new blog files) is still real and visible in Action
      // Center, but promising a blog it can't ship would be a lie.
      if (actionCenter?.deferred) {
        setBlogPrompt('requested');
      } else {
        setBlogPrompt('declined');
        setBlogError(
          actionCenter?.blockedReason
            || 'Added to Action Center, but it needs setup before the agent can ship it — check Action Center.'
        );
      }
      onKeywordQueued?.();
    } catch (err) {
      setBlogPrompt('asking');
      setBlogError(err.message || 'Could not request a blog for that keyword.');
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
      {blogPrompt === 'asking' || blogPrompt === 'requesting' ? (
        <div className="mt-2.5 rounded-xl border border-indigo-500/25 bg-indigo-500/[0.04] px-3 py-2.5">
          <p className="text-[11px] font-bold text-slate-800 flex items-center gap-1.5">
            <PenLine size={11} className="text-indigo-600 shrink-0" />
            Write a blog post on this topic?
          </p>
          <p className="text-[10px] font-medium text-slate-500 mt-1">
            One post, written and shipped by the agent in tomorrow's run — same format as every other blog.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={requestBlog}
              disabled={blogPrompt === 'requesting'}
              className="an-grad-btn text-[11px] font-bold px-3 py-1.5 rounded-lg text-white flex items-center gap-1.5 cursor-pointer"
            >
              {blogPrompt === 'requesting' ? <Loader2 size={11} className="animate-spin" /> : null}
              Yes, write it
            </button>
            <button
              type="button"
              onClick={() => setBlogPrompt('declined')}
              disabled={blogPrompt === 'requesting'}
              className="text-[11px] font-bold px-3 py-1.5 rounded-lg text-slate-600 hover:text-slate-800 cursor-pointer"
            >
              No thanks
            </button>
          </div>
        </div>
      ) : null}
      {blogPrompt === 'requested' && (
        <p className="text-[11px] font-semibold text-indigo-700 mt-2 flex items-start gap-1.5">
          <PenLine size={11} className="shrink-0 mt-0.5" />
          <span>
            A blog on "{queueResult?.topic}" is queued — the agent writes and ships it in tomorrow's run.
          </span>
        </p>
      )}
      {blogError && (
        <p className="text-[11px] font-semibold text-rose-600 mt-2 flex items-start gap-1.5">
          <AlertTriangle size={11} className="shrink-0 mt-0.5" />
          <span>{blogError}</span>
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
