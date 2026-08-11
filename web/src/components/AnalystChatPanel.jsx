import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Sparkles, Send, Bot, AlertTriangle, Wrench, Target, Loader2, CheckCircle2 } from 'lucide-react';

// Inline (non-drawer) analyst chat. Same api.analyst.ask backend as the old
// AnalystCopilotDrawer — that agent reads the nightly metric/anomaly/forecast
// cache and has no keyword tools, so asking it to "target this keyword" would
// only produce prose. The Grow-for-a-keyword box below is therefore a real
// action against the keyword queue, not a chat message.
const STARTER_QUESTIONS = [
  "Which keywords are closest to page 1?",
  "What's putting impressions at risk?",
  'Why did clicks change this week?',
  'What should I fix first?',
];

export default function AnalystChatPanel({ clientId, onKeywordQueued }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);

  const [keyword, setKeyword] = useState('');
  const [queueing, setQueueing] = useState(false);
  const [queueResult, setQueueResult] = useState(null);
  const [queueError, setQueueError] = useState(null);

  const scrollRef = useRef(null);

  // Conversation is scoped to one client — carrying it across a client switch
  // would attach answers about site A to site B.
  useEffect(() => {
    setMessages([]);
    setError(null);
    setInput('');
    setKeyword('');
    setQueueResult(null);
    setQueueError(null);
  }, [clientId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, asking]);

  const ask = async (question) => {
    const text = (question ?? input).trim();
    if (!text || asking) return;
    setInput('');
    setError(null);
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setAsking(true);
    try {
      const res = await api.analyst.ask(clientId, text);
      setMessages((m) => [...m, { role: 'assistant', content: res.answer, toolCalls: res.tool_calls || [] }]);
    } catch (e) {
      setError(e.message || 'Something went wrong — try again.');
      setMessages((m) => m.slice(0, -1));
    } finally {
      setAsking(false);
    }
  };

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
    <div className="an-panel flex flex-col overflow-hidden lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)]">
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-slate-200 shrink-0">
        <div className="w-8 h-8 rounded-xl grid place-items-center bg-gradient-to-br from-indigo-500 to-violet-600 text-white shrink-0">
          <Sparkles size={15} />
        </div>
        <div>
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Ask the analyst</h2>
          <p className="text-[11px] font-medium text-slate-500">Questions about this client's data</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-[16rem]">
        {messages.length === 0 && (
          <div className="space-y-2">
            <div className="an-label">Try asking</div>
            {STARTER_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => ask(q)}
                className="w-full text-left text-[11px] font-bold text-slate-600 bg-slate-100/60 border border-slate-200 hover:border-indigo-300 hover:text-slate-900 rounded-xl px-3.5 py-2.5 transition cursor-pointer"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex gap-2.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role !== 'user' && (
              <span className="w-7 h-7 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white grid place-items-center shrink-0">
                <Bot size={12} />
              </span>
            )}
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[11px] leading-relaxed border ${
                m.role === 'user'
                  ? 'bg-indigo-600 text-white border-indigo-500 rounded-tr-none font-semibold'
                  : 'bg-slate-100/70 border-slate-200 text-slate-700 rounded-tl-none font-medium'
              }`}
            >
              <p className="whitespace-pre-line">{m.content}</p>
              {m.toolCalls?.length > 0 && (
                <div className="mt-2 pt-2 border-t border-slate-200 flex flex-wrap gap-1.5 items-center">
                  <Wrench size={9} className="text-slate-400" />
                  {m.toolCalls.map((tc, j) => (
                    <span
                      key={j}
                      className="text-[9px] font-bold text-indigo-600 bg-white border border-slate-200 rounded-md px-1.5 py-0.5 font-mono"
                    >
                      {tc.tool}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {asking && (
          <div className="flex justify-start gap-2.5">
            <span className="w-7 h-7 rounded-xl bg-slate-100 border border-slate-200 grid place-items-center text-indigo-600 shrink-0">
              <Bot size={12} />
            </span>
            <div className="bg-slate-100/70 border border-slate-200 rounded-2xl rounded-tl-none px-3.5 py-2.5 flex gap-1.5 items-center">
              {[0, 120, 240].map((d) => (
                <span
                  key={d}
                  className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce"
                  style={{ animationDelay: `${d}ms` }}
                />
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="text-[11px] font-semibold text-rose-600 bg-rose-500/[0.06] border border-rose-500/25 rounded-xl p-3 flex items-center gap-2">
            <AlertTriangle size={12} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); ask(); }}
        className="px-5 py-3 border-t border-slate-200 shrink-0 flex items-center gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about this client…"
          disabled={asking}
          className="an-input flex-1 text-[11px] font-semibold py-2.5"
        />
        <button
          type="submit"
          disabled={asking || !input.trim()}
          aria-label="Send message"
          className="an-grad-btn w-9 h-9 rounded-xl grid place-items-center text-white shrink-0 cursor-pointer"
        >
          <Send size={12} />
        </button>
      </form>

      {/* ── Growth target ────────────────────────────────────────────── */}
      <div className="px-5 py-4 border-t border-slate-200 shrink-0 bg-slate-100/40">
        <div className="flex items-center gap-1.5 mb-2">
          <Target size={11} className="text-indigo-600 shrink-0" />
          <span className="an-label">Grow for a keyword</span>
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
                ? `"${queueResult.topic}" is already waiting for review under Ready to publish.`
                : `"${queueResult.topic}" added under Ready to publish — send it to Action Center when you're ready.`}
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
    </div>
  );
}
