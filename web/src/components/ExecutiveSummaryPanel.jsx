import Section from './layout/Section.jsx';
import { timeAgo } from '../api.js';

// Today's summary — plain-English narrative for non-technical readers.
// `source` is kept in the signature for callers (Reports, AiGrowth).
export default function ExecutiveSummaryPanel({ text, source, generatedAt }) {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);

  return (
    <Section label="Today" source="Executive report" title="Today's summary" subtitle="Prepared by your AI assistant"
      action={generatedAt ? <span className="text-[13px] text-faint">Updated {timeAgo(generatedAt)}</span> : null}>
      <div className="card px-4 py-3 text-sm leading-6 text-text">
        {lines.length > 1 ? (
          <ul className="space-y-2">
            {lines.map((line, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className="mt-2 w-1.5 h-1.5 rounded-full bg-faint-2 shrink-0" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="whitespace-pre-line">{lines[0] || 'Report generating — check back after today\'s update.'}</p>
        )}
      </div>
    </Section>
  );
}
