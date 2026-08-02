import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Sparkles, Send, X, Bot, CornerDownLeft, AlertTriangle, Wrench } from 'lucide-react';

const STARTER_QUESTIONS = [
  'Why did clicks change this week?',
  'Which pages drove the drop?',
  'Show me the mobile trend.',
  'What should I check next?',
];

export default function AnalystCopilotDrawer({ open, onClose, clientId }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  // The Python /ask endpoint is stateless per call (no conversationId, no
  // server-side multi-turn memory — see data-analyst-agent/app/api/routes/
  // ask.py) — this history is purely local UI state, so it must be wiped on
  // client switch or a staff member could see client A's conversation while
  // looking at client B's numbers.
  useEffect(() => { setMessages([]); setError(null); setInput(''); }, [clientId]);

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
      setMessages((m) => [...m, { role: 'assistant', content: res.answer, toolCalls: res.tool_calls || [], status: res.status }]);
    } catch (e) {
      setError(e.message || 'Something went wrong — try again.');
      setMessages((m) => m.slice(0, -1));
    } finally {
      setAsking(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-slate-900/10 backdrop-blur-[2px] z-40 animate-fade-in" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 sm:inset-y-4 sm:right-4 w-full sm:w-[420px] bg-slate-50/95 backdrop-blur-xl z-50 sm:rounded-[32px] border border-slate-200/80 shadow-[0_24px_64px_-12px_rgba(99,102,241,0.18)] flex flex-col overflow-hidden animate-slide-left"
        role="dialog" aria-label="Analyst Copilot">
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-slate-200/50 shrink-0 bg-white/60 relative z-10">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white grid place-items-center shadow-lg shadow-indigo-500/15 border border-white/10 shrink-0">
              <Sparkles size={15} />
            </span>
            <div>
              <div className="text-xs font-black text-slate-800 uppercase tracking-widest leading-none">Ask Deeper</div>
              <div className="text-[9px] font-bold text-slate-400 mt-1 uppercase tracking-wide">This client only</div>
            </div>
          </div>
          <button onClick={onClose}
            className="w-10 h-10 rounded-full border border-slate-200/60 hover:border-slate-350 grid place-items-center text-slate-400 hover:text-slate-700 hover:bg-white shadow-sm transition active:scale-95 focus:outline-none"
            aria-label="Close">
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-4 relative z-10">
          {messages.length === 0 && (
            <div className="space-y-2.5 pt-2">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">Try asking</div>
              {STARTER_QUESTIONS.map((q) => (
                <button key={q} onClick={() => ask(q)}
                  className="w-full text-left text-[11.5px] font-bold text-slate-700 bg-white border border-slate-200/70 hover:border-indigo-200 hover:text-indigo-650 rounded-2xl px-4 py-3 transition shadow-sm focus:outline-none">
                  {q}
                </button>
              ))}
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}>
              {m.role !== 'user' && (
                <span className="w-8 h-8 rounded-2xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 text-white grid place-items-center shrink-0 shadow-md border border-white/20">
                  <Bot size={13} />
                </span>
              )}
              <div className={`max-w-[85%] rounded-[20px] px-4 py-3 text-[13px] leading-relaxed shadow-sm border ${
                m.role === 'user'
                  ? 'text-white bg-gradient-to-br from-indigo-650 via-indigo-500 to-violet-500 border-indigo-500/30 rounded-tr-none'
                  : 'bg-white/80 border-slate-200/60 text-slate-800 rounded-tl-none'
              }`}>
                <p className="whitespace-pre-line font-medium">{m.content}</p>
                {m.toolCalls?.length > 0 && (
                  <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex flex-wrap gap-1.5 items-center">
                    <Wrench size={10} className="text-slate-350" />
                    {m.toolCalls.map((tc, j) => (
                      <span key={j} className="text-[9px] font-bold text-slate-400 bg-slate-50 border border-slate-150 rounded-lg px-1.5 py-0.5">
                        {tc.tool}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {asking && (
            <div className="flex justify-start gap-3 animate-pulse">
              <span className="w-8 h-8 rounded-2xl bg-white border border-slate-200 grid place-items-center text-slate-450 shrink-0 shadow-sm">
                <Bot size={13} />
              </span>
              <div className="bg-white/80 border border-slate-200/60 rounded-[20px] rounded-tl-none px-4 py-3 flex gap-1.5 items-center shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '120ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '240ms' }} />
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-2xl p-4 flex items-center gap-2">
              <AlertTriangle size={14} className="text-rose-500 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="p-4 border-t border-slate-200/50 shrink-0 bg-white relative z-10 flex items-center gap-2">
          <div className="flex-1 relative flex items-center">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about this client…"
              disabled={asking}
              className="w-full text-xs font-semibold border border-slate-200/80 rounded-2xl pl-4 pr-12 py-3 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 disabled:opacity-60 transition duration-150 text-slate-800 placeholder:text-slate-400"
            />
            {input.trim() && (
              <span className="absolute right-3 text-[8px] font-black uppercase text-slate-400 tracking-wider font-mono flex items-center gap-0.5 border border-slate-200 bg-white rounded-lg px-1.5 py-0.5 pointer-events-none">
                <CornerDownLeft size={8} />
              </span>
            )}
          </div>
          <button type="submit" disabled={asking || !input.trim()}
            className="w-10 h-10 rounded-2xl grid place-items-center text-white transition active:scale-95 disabled:opacity-40 shadow-md focus:outline-none shrink-0"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
            aria-label="Send message">
            <Send size={13} />
          </button>
        </form>
      </div>
    </>
  );
}
