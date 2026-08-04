import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Sparkles, Send, X, Bot, CornerDownLeft, AlertTriangle, Wrench } from 'lucide-react';

const STARTER_QUESTIONS = [
  'Why did clicks change this week?',
  'Which pages drove the drop?',
  'Show me the mobile trend.',
  'What should I check next?',
];

export default function AnalystCopilotDrawer({ open, onClose, clientId, initialPrompt }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    setMessages([]);
    setError(null);
    setInput('');
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
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: res.answer, toolCalls: res.tool_calls || [], status: res.status },
      ]);
    } catch (e) {
      setError(e.message || 'Something went wrong — try again.');
      setMessages((m) => m.slice(0, -1));
    } finally {
      setAsking(false);
    }
  };

  useEffect(() => {
    if (open && initialPrompt) {
      ask(initialPrompt);
    }
  }, [open, initialPrompt]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-xs z-40 animate-fade-in" onClick={onClose} />
      <div
        className="fixed inset-y-0 right-0 sm:inset-y-4 sm:right-4 w-full sm:w-[440px] bg-white text-slate-900 backdrop-blur-xl z-50 sm:rounded-[32px] border border-slate-800 shadow-2xl flex flex-col overflow-hidden animate-slide-left"
        role="dialog"
        aria-label="Analyst Copilot"
      >
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-slate-800 shrink-0 bg-slate-950/60 relative z-10">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-slate-900 grid place-items-center shadow-lg border border-white/10 shrink-0">
              <Sparkles size={15} />
            </span>
            <div>
              <div className="text-xs font-black uppercase tracking-widest leading-none text-slate-900">
                Perplexity AI Copilot
              </div>
              <div className="text-[9px] font-bold text-slate-400 mt-1 uppercase tracking-wide">
                Scoped to Client #{clientId}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full border border-slate-800 hover:border-slate-200 grid place-items-center text-slate-400 hover:text-slate-900 bg-slate-100 shadow-sm transition active:scale-95 focus:outline-none"
            aria-label="Close"
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-4 relative z-10 custom-scrollbar">
          {messages.length === 0 && (
            <div className="space-y-3 pt-2">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                Suggested Prompt Questions
              </div>
              {STARTER_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => ask(q)}
                  className="w-full text-left text-xs font-bold text-slate-700 bg-slate-100 border border-slate-800 hover:border-violet-500 hover:text-slate-900 rounded-2xl px-4 py-3 transition shadow-xs focus:outline-none"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {messages.map((m, i) => (
            <div
              key={i}
              className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}
            >
              {m.role !== 'user' && (
                <span className="w-8 h-8 rounded-2xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 text-slate-900 grid place-items-center shrink-0 shadow-md border border-white/20">
                  <Bot size={13} />
                </span>
              )}
              <div
                className={`max-w-[85%] rounded-[20px] px-4 py-3 text-xs leading-relaxed shadow-sm border ${
                  m.role === 'user'
                    ? 'text-slate-900 bg-gradient-to-br from-indigo-600 to-violet-600 border-indigo-500/30 rounded-tr-none font-semibold'
                    : 'bg-slate-200/60 border-slate-300 text-slate-100 rounded-tl-none font-medium'
                }`}
              >
                <p className="whitespace-pre-line leading-relaxed">{m.content}</p>
                {m.toolCalls?.length > 0 && (
                  <div className="mt-2.5 pt-2.5 border-t border-slate-200 flex flex-wrap gap-1.5 items-center">
                    <Wrench size={10} className="text-slate-400" />
                    {m.toolCalls.map((tc, j) => (
                      <span
                        key={j}
                        className="text-[9px] font-bold text-indigo-500 bg-white border border-slate-200 rounded-lg px-1.5 py-0.5 font-mono"
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
            <div className="flex justify-start gap-3 animate-pulse">
              <span className="w-8 h-8 rounded-2xl bg-slate-100 border border-slate-200 grid place-items-center text-indigo-600 shrink-0 shadow-xs">
                <Bot size={13} />
              </span>
              <div className="bg-slate-200/60 border border-slate-200 rounded-[20px] rounded-tl-none px-4 py-3 flex gap-1.5 items-center shrink-0">
                <span
                  className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce"
                  style={{ animationDelay: '0ms' }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce"
                  style={{ animationDelay: '120ms' }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce"
                  style={{ animationDelay: '240ms' }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs font-semibold text-rose-600 bg-rose-950/60 border border-rose-800 rounded-2xl p-4 flex items-center gap-2">
              <AlertTriangle size={14} className="text-rose-600 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
          className="p-4 border-t border-slate-800 shrink-0 bg-slate-950 relative z-10 flex items-center gap-2"
        >
          <div className="flex-1 relative flex items-center">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about this client..."
              disabled={asking}
              className="w-full text-xs font-semibold border border-slate-800 rounded-2xl pl-4 pr-12 py-3 bg-white text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 disabled:opacity-60 transition duration-150"
            />
            {input.trim() && (
              <span className="absolute right-3 text-[8px] font-black uppercase text-slate-400 tracking-wider font-mono flex items-center gap-0.5 border border-slate-800 bg-slate-950 rounded-lg px-1.5 py-0.5 pointer-events-none">
                <CornerDownLeft size={8} />
              </span>
            )}
          </div>
          <button
            type="submit"
            disabled={asking || !input.trim()}
            className="w-10 h-10 rounded-2xl grid place-items-center text-slate-900 transition active:scale-95 disabled:opacity-40 shadow-md focus:outline-none shrink-0"
            style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}
            aria-label="Send message"
          >
            <Send size={13} />
          </button>
        </form>
      </div>
    </>
  );
}
