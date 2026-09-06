import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../api.js';

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
    <div className="an-panel p-4 flex items-start gap-3 bg-gradient-to-br from-indigo-50/60 to-white border-indigo-100/70">
      <span className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white grid place-items-center shrink-0 shadow-sm">
        <Sparkles size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[9px] font-black uppercase tracking-widest text-indigo-500 mb-1">AI Briefing</div>
        {loading ? (
          <div className="h-3.5 w-3/4 rounded bg-slate-200 animate-pulse" />
        ) : (
          <p className="text-[12.5px] font-medium text-slate-700 leading-relaxed">{text}</p>
        )}
      </div>
    </div>
  );
}
