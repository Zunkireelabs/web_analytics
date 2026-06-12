import { useState } from 'react';
import { api } from '../api.js';

const ACCENT = '#6C63FF';
const SUGGESTIONS = [
  'How did this day perform?',
  'Which query should I focus on?',
  'How is mobile vs desktop?',
  'Any opportunities I\'m missing?',
];

// "Ask your data" — an AI chat-style panel with grounded answers for the selected day.
export default function AiPanel({ siteId, date }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const ask = async (q) => {
    const text = (q ?? question).trim();
    if (!text || !siteId) return;
    setBusy(true); setErr(''); setAnswer('');
    try { setAnswer((await api.aiAsk(siteId, date, text)).answer); }
    catch { setErr('Could not get an answer. Try again.'); }
    finally { setBusy(false); }
  };

  const freshInsight = async () => {
    if (!siteId) return;
    setBusy(true); setErr(''); setAnswer('');
    try { setAnswer((await api.aiSummary(siteId, date)).summary); }
    catch { setErr('Could not generate an insight. Try again.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card p-5 fade-up">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg grid place-items-center text-white shadow-md shadow-indigo-500/30"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>💬</div>
          <span className="text-sm font-semibold text-slate-800">Ask your data</span>
        </div>
        <button onClick={freshInsight} disabled={busy}
          className="text-xs px-3 py-1.5 rounded-lg border border-indigo-200 hover:bg-indigo-50 disabled:opacity-50"
          style={{ color: ACCENT }}>
          ✨ Fresh insight
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => { setQuestion(s); ask(s); }} disabled={busy}
            className="text-xs px-3 py-1.5 rounded-full border border-slate-200 text-slate-600 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/50 transition disabled:opacity-50">
            {s}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder={`Ask anything about ${date}…`}
          className="flex-1 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        />
        <button onClick={() => ask()} disabled={busy}
          className="text-white rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
          {busy ? '…' : 'Ask'}
        </button>
      </div>

      {err && <div className="text-sm text-rose-600 mt-3">{err}</div>}

      {(busy || answer) && (
        <div className="flex items-start gap-2.5 mt-4">
          <div className="w-7 h-7 rounded-lg grid place-items-center text-white text-xs shrink-0"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>AI</div>
          <div className="flex-1 rounded-2xl rounded-tl-sm bg-slate-50 border border-slate-100 px-4 py-3 text-sm leading-relaxed text-slate-800 whitespace-pre-line">
            {busy ? <span className="text-slate-400">Thinking…</span> : answer}
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-400 mt-3">
        Answers use your real data for {date}. AI can occasionally be off — double-check important decisions.
      </p>
    </div>
  );
}
