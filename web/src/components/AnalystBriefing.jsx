import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../api.js';
import { Tray, TrayCard } from './layout/Tray.jsx';

// Per-client AI briefing — a short, fresh narrative generated for whichever
// client is currently selected, not a fixed headline the way the rest of
// the page's labels are. Reuses the ask_analyst_data capability
// (server/assistant/capabilities.js) rather than a new endpoint: it's the
// same LLM-over-real-findings call the Admin Assistant chat already makes,
// just invoked directly with a fixed prompt instead of typed by a person.
// Silent on failure (no banner) — a missing briefing is a lot less jarring
// than an error card at the very top of the page, and the rest of the page
// works fine without it.
const PROMPT = "Give me a 2-3 sentence executive briefing on this client's current performance — what's going well, what needs attention, in plain language.";

export default function AnalystBriefing({ clientId }) {
  const [text, setText] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setText(null);
    setLoading(true);
    let cancelled = false;
    api.assistant.invoke('ask_analyst_data', { question: PROMPT }, clientId)
      .then((res) => { if (!cancelled && res.ok) setText(res.data.answer); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [clientId]);

  if (!loading && !text) return null;

  return (
    <Tray>
      <TrayCard>
        <div className="p-4 flex items-start gap-3">
          <span className="w-8 h-8 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0"
            style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>
            <Sparkles size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-fg mb-1">AI briefing</div>
            {loading ? (
              <div className="h-3.5 w-3/4 rounded bg-muted animate-pulse" />
            ) : (
              <p className="text-sm leading-5 text-text">{text}</p>
            )}
          </div>
        </div>
      </TrayCard>
    </Tray>
  );
}
