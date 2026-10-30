import { Info } from 'lucide-react';
import { buildOutlookStory, problemSummary } from '../../lib/analyst-view.js';

// The plain-words summary at the top of Outlook. Built only from what the API returned.
export default function StoryCard({ outlook, onSeeFixes }) {
  const story = buildOutlookStory(outlook);
  if (!story) return null;
  const summary = problemSummary(outlook.problemCounts);
  return (
    <div className="tray">
      <div className="tray-card">
        <div className="px-5 py-4 flex items-start gap-3">
          <span className="w-8 h-8 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0" style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}><Info size={16} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-fg">The week ahead, in plain words</h2>
            <p className="text-[14px] leading-[22px] text-text mt-1">{story}</p>
          </div>
          {summary && (
            <div className="shrink-0 text-right hidden md:block">
              <div className="text-[13px] text-text">{summary.headline}</div>
              <button type="button" onClick={onSeeFixes} className="text-xs text-primary hover:underline">
                {summary.detail ? `${summary.detail} · ` : ''}See Fixes →
              </button>
            </div>
          )}
        </div>
        {summary && (
          <div className="md:hidden px-5 pb-3 -mt-1">
            <button type="button" onClick={onSeeFixes} className="text-xs text-primary hover:underline text-left">
              {summary.headline}. {summary.detail ? `${summary.detail} · ` : ''}See Fixes →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
