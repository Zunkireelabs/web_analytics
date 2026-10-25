import { useState } from 'react';
import { api } from '../api.js';
import { Loader2, CheckCircle2, AlertTriangle, PenLine } from 'lucide-react';
import { STATUS } from '../lib/palette.js';
import Button from './Button.jsx';
import Field from './Field.jsx';
import { Tray, TrayCard } from './layout/Tray.jsx';

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
    <Tray>
      <TrayCard
        title="Grow for a keyword"
        subtitle="Tell the agent a topic to target, even without impressions yet"
      >
        <div className="px-4 pb-4">
          <form onSubmit={queueKeyword} className="flex items-center gap-2">
            <Field
              className="flex-1"
              aria-label="Keyword to grow for"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="e.g. best travel insurance"
              maxLength={200}
              disabled={queueing}
            />
            <Button type="submit" variant="primary" disabled={queueing || !keyword.trim()} className="shrink-0">
              {queueing ? <Loader2 size={14} className="animate-spin" /> : null}
              Add
            </Button>
          </form>

          {queueResult && (
            <p className="text-[13px] mt-2.5 flex items-start gap-1.5" style={{ color: STATUS.good.text }}>
              <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
              <span>
                {queueResult.alreadyQueued
                  ? `"${queueResult.topic}" is already waiting for review under Keyword Discovery.`
                  : `"${queueResult.topic}" added under Keyword Discovery — send it to Action Center when you're ready.`}
              </span>
            </p>
          )}
          {blogPrompt === 'asking' || blogPrompt === 'requesting' ? (
            <div className="mt-2.5 rounded-card bg-muted px-3.5 py-3">
              <p className="text-[13px] font-medium text-fg flex items-center gap-1.5">
                <PenLine size={13} className="text-primary shrink-0" />
                Write a blog post on this topic?
              </p>
              <p className="text-xs text-faint mt-1">
                One post, written and shipped by the agent in tomorrow's run — same format as every other blog.
              </p>
              <div className="flex items-center gap-2 mt-2.5">
                <Button variant="primary" size="sm" onClick={requestBlog} disabled={blogPrompt === 'requesting'}>
                  {blogPrompt === 'requesting' ? <Loader2 size={12} className="animate-spin" /> : null}
                  Yes, write it
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setBlogPrompt('declined')} disabled={blogPrompt === 'requesting'}>
                  No thanks
                </Button>
              </div>
            </div>
          ) : null}
          {blogPrompt === 'requested' && (
            <p className="text-[13px] text-text mt-2.5 flex items-start gap-1.5">
              <PenLine size={13} className="shrink-0 mt-0.5 text-primary" />
              <span>
                A blog on "{queueResult?.topic}" is queued — the agent writes and ships it in tomorrow's run.
              </span>
            </p>
          )}
          {blogError && (
            <p className="text-xs mt-2.5 flex items-start gap-1.5" style={{ color: STATUS.critical.text }}>
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>{blogError}</span>
            </p>
          )}
          {queueError && (
            <p className="text-xs mt-2.5 flex items-start gap-1.5" style={{ color: STATUS.critical.text }}>
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>{queueError}</span>
            </p>
          )}
          {!queueResult && !queueError && (
            <p className="text-xs text-faint mt-2.5">
              Queued for your review first — nothing is published until you send it to Action Center.
            </p>
          )}
        </div>
      </TrayCard>
    </Tray>
  );
}
