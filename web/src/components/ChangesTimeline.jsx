import { timeAgo } from '../api.js';
import { PlusCircle, CheckCircle2, TrendingUp, TrendingDown, Activity, Link2, Database, Sparkles } from 'lucide-react';
import Badge from './Badge.jsx';
import { STATUS } from '../lib/palette.js';

// Icon per change type; the 6px dot beside the label carries the status colour.
const MARKER = {
  health: {
    up: { icon: TrendingUp, color: STATUS.good.color },
    down: { icon: TrendingDown, color: STATUS.critical.color },
  },
  resolved: { icon: CheckCircle2, color: STATUS.good.color },
  new: { icon: PlusCircle, color: STATUS.critical.color },
  fallback: { icon: Activity, color: STATUS.neutral.color },
};

const PREFIX = { health: '', resolved: 'Resolved: ', new: 'New: ' };

function pagePath(page) {
  try {
    const url = new URL(page);
    return url.pathname + url.search;
  } catch {
    return page;
  }
}

function parseTextStructure(text) {
  const parensMatches = [...text.matchAll(/\(([^)]+)\)/g)].map(m => m[1]);
  const quotesMatches = [...text.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  
  let cleanText = text;
  const paths = [];
  const contexts = [];
  const titles = [];
  
  parensMatches.forEach(match => {
    if (match.startsWith('/') || match.startsWith('http://') || match.startsWith('https://')) {
      paths.push(match);
    } else {
      contexts.push(match);
    }
    cleanText = cleanText.replace(`(${match})`, '');
  });
  
  quotesMatches.forEach(match => {
    if (match.startsWith('/') || match.startsWith('http://') || match.startsWith('https://')) {
      paths.push(match);
    } else if (match.length > 15) {
      titles.push(match);
    }
    cleanText = cleanText.replace(`"${match}"`, '');
  });
  
  // Clean up formatting
  cleanText = cleanText.replace(/\s+/g, ' ').replace(/\(\s*\)/g, '').replace(/""/g, '').trim();
  if (cleanText.endsWith('.')) cleanText = cleanText.slice(0, -1);
  
  return { cleanText, paths, contexts, titles };
}

export default function ChangesTimeline({ items }) {
  if (!items?.length) {
    return <div className="border-t border-border py-10 text-center text-sm text-faint">No changes logged since the last analysis.</div>;
  }

  return (
    <div className="border-t border-border">
      {items.map((c, i) => {
        const isHealth = c.type === 'health';
        const m = isHealth ? MARKER.health[c.positive ? 'up' : 'down'] : MARKER[c.type] || MARKER.fallback;
        const IconComponent = m.icon;
        const isNew = c.type === 'new';
        const parsed = parseTextStructure(c.text);

        return (
          <div key={i} className="flex gap-3 px-4 py-3 border-b border-border last:border-0">
            <span className="w-7 h-7 rounded-control bg-muted text-text grid place-items-center shrink-0">
              <IconComponent size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs text-faint flex-wrap">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: m.color }} />
                <span>{PREFIX[c.type]?.replace(': ', '') || 'Audit Update'}</span>
                {isNew && c.priority === 'high' && <Badge tone="red">Critical</Badge>}
              </div>
              <p className="text-sm text-fg mt-0.5 break-words">{parsed.cleanText}</p>

              {(parsed.paths.length > 0 || parsed.contexts.length > 0 || parsed.titles.length > 0) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {parsed.paths.map((p, idx) => (
                    <span key={idx} className="inline-flex items-center gap-1.5 max-w-full h-[22px] px-2 rounded-control bg-muted text-xs font-mono text-text">
                      <Link2 size={11} className="shrink-0 text-faint" />
                      <span className="truncate" title={p}>{pagePath(p)}</span>
                    </span>
                  ))}
                  {parsed.contexts.map((ctx, idx) => (
                    <span key={idx} className="inline-flex items-center gap-1.5 max-w-full h-[22px] px-2 rounded-control bg-muted text-xs text-text">
                      <Database size={11} className="shrink-0 text-faint" />
                      <span className="truncate">{ctx}</span>
                    </span>
                  ))}
                  {parsed.titles.map((t, idx) => (
                    <span key={idx} className="inline-flex items-center gap-1.5 max-w-full h-[22px] px-2 rounded-control bg-muted text-xs text-text">
                      <Sparkles size={11} className="shrink-0 text-faint" />
                      <span className="truncate">"{t}"</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <span className="text-xs text-faint shrink-0">{timeAgo(c.at)}</span>
          </div>
        );
      })}
    </div>
  );
}
