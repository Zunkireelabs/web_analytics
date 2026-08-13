import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../api.js';
import { SEVERITY_META, finding, isDecline } from '../lib/analystFormat.js';
import {
  Sparkles, Send, Bot, AlertTriangle, X, Compass, Clock, ArrowRight,
  TrendingUp, ShieldAlert, Activity, ListChecks,
} from 'lucide-react';

// Chat-bubble scale (11px) markdown — the analyst agent's prose comes back
// with real markdown syntax (**bold**, lists), which read as literal
// asterisks before this. No heading styles: a chat bubble is one paragraph
// of prose, not a report.
const MD_COMPONENTS = {
  p: ({ children }) => <p className="whitespace-pre-line mb-1.5 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-extrabold text-slate-900">{children}</strong>,
  ul: ({ children }) => <ul className="list-disc pl-3.5 space-y-0.5 mb-1.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-3.5 space-y-0.5 mb-1.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline font-bold">
      {children}
    </a>
  ),
  code: ({ children }) => <code className="font-mono text-[10px] bg-white/70 rounded px-1 py-0.5">{children}</code>,
};

// Tool names that mean the answer is grounded in specific dashboard
// insights — those are exactly the rows the Impression Forecast panel
// already renders with real Fix/Dismiss/Send-to-Action-Center buttons.
// Rather than leaving the agent's answer as a flat prose paragraph (which
// read as "not really an assistant" — no different from a plain API dump),
// an answer grounded this way gets the same structured insight cards
// AnalystGrowthPulse uses, pulled from the SAME already-fetched dashboard
// data, not a second guess at what the prose meant.
function answerHasFixableIssues(toolCalls) {
  return (toolCalls || []).some((tc) => /insight|anomaly|forecast/i.test(tc.tool || ''));
}

function daysLabel(days) {
  if (days == null) return null;
  if (days > 0) return `${days}d out`;
  if (days === 0) return 'today';
  return 'overdue';
}

// Same api.analyst.ask backend as the old AnalystCopilotDrawer — that agent
// reads the nightly metric/anomaly/forecast cache and has no keyword tools,
// so asking it to "target this keyword" would only produce prose. Growing a
// keyword is a separate, standalone action (AnalystGrowKeyword) for that
// reason, not a chat message.
const STARTER_QUESTIONS = [
  { text: 'Which keywords are closest to page 1?', desc: 'Fastest wins', icon: TrendingUp, color: '#059669', bg: 'from-emerald-50 to-emerald-100/30' },
  { text: "What's putting impressions at risk?", desc: 'Early warnings', icon: ShieldAlert, color: '#dc2626', bg: 'from-rose-50 to-rose-100/30' },
  { text: 'Why did clicks change this week?', desc: 'Explain a trend', icon: Activity, color: '#6C63FF', bg: 'from-violet-50 to-violet-100/30' },
  { text: 'What should I fix first?', desc: 'Prioritize', icon: ListChecks, color: '#d97706', bg: 'from-amber-50 to-amber-100/30' },
];

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

export default function AnalystChatPanel({ clientId, dashboard, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);

  const scrollRef = useRef(null);

  const metrics = useMemo(() => Object.values(dashboard?.groups || {}).flat(), [dashboard]);
  const metricFor = (key) => metrics.find((m) => m.metric_key === key) || { metric_key: key, display_name: key };

  const topInsights = useMemo(() => {
    const risks = (dashboard?.insights || []).filter(isDecline);
    return [...risks]
      .sort((a, b) => {
        const sevDiff = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
        if (sevDiff !== 0) return sevDiff;
        return (a.evidence?.days_until_drop ?? Infinity) - (b.evidence?.days_until_drop ?? Infinity);
      })
      .slice(0, 3);
  }, [dashboard]);

  // Conversation is scoped to one client — carrying it across a client switch
  // would attach answers about site A to site B.
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
      setMessages((m) => [...m, { role: 'assistant', content: res.answer, toolCalls: res.tool_calls || [] }]);
    } catch (e) {
      setError(e.message || 'Something went wrong — try again.');
      setMessages((m) => m.slice(0, -1));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="flex flex-col overflow-hidden h-full">
      <div className="relative flex items-center gap-3 px-5 py-4 border-b border-slate-200 shrink-0 bg-gradient-to-br from-indigo-500/[0.07] via-transparent to-transparent overflow-hidden">
        <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-indigo-500/10 blur-2xl pointer-events-none" />
        <div className="relative w-9 h-9 rounded-xl grid place-items-center bg-gradient-to-br from-indigo-500 to-violet-600 text-white shrink-0 shadow-lg shadow-indigo-500/20">
          <Sparkles size={16} />
          <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-white" />
        </div>
        <div className="relative min-w-0 flex-1">
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Ask the analyst</h2>
          <p className="text-[11px] font-medium text-slate-500">Your growth agent for this client — ask anything</p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            className="relative w-8 h-8 rounded-full border border-slate-200 bg-white grid place-items-center text-slate-400 hover:text-slate-700 hover:border-slate-300 transition shrink-0 cursor-pointer shadow-sm"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-[16rem]">
        {messages.length === 0 && (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200/60 rounded-2xl p-4 shadow-sm">
              <p className="text-[12.5px] font-extrabold text-slate-800 leading-snug">
                Hi — how can I help you grow this client today?
              </p>
              <p className="text-[10.5px] font-medium text-slate-400 mt-1 leading-relaxed">
                I can read this client's search performance, forecasts, and early warnings.
              </p>
            </div>

            <div className="flex items-center gap-1.5">
              <Compass size={11} className="text-slate-400" />
              <span className="an-label">Select starter prompt</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {STARTER_QUESTIONS.map((q) => {
                const Icon = q.icon;
                return (
                  <button
                    key={q.text}
                    type="button"
                    onClick={() => ask(q.text)}
                    className={`group text-left bg-gradient-to-br ${q.bg} hover:scale-[1.02] border border-slate-200/60 hover:border-slate-300 rounded-2xl p-3.5 transition-all duration-200 flex flex-col justify-between min-h-[92px] shadow-sm hover:shadow-md cursor-pointer`}
                  >
                    <span
                      className="w-7 h-7 rounded-xl bg-white border border-slate-200/50 grid place-items-center shadow-sm shrink-0"
                      style={{ color: q.color }}
                    >
                      <Icon size={13} strokeWidth={2.5} />
                    </span>
                    <div className="mt-2.5">
                      <div className="text-[11px] font-extrabold text-slate-800 leading-snug">{q.text}</div>
                      <div className="text-[9px] font-bold text-slate-400 mt-0.5 uppercase tracking-wider">{q.desc}</div>
                    </div>
                  </button>
                );
              })}
            </div>
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
              className={`${m.role === 'user' ? 'max-w-[85%]' : 'max-w-[92%]'} rounded-2xl px-3.5 py-2.5 text-[11px] leading-relaxed border ${
                m.role === 'user'
                  ? 'bg-indigo-600 text-white border-indigo-500 rounded-tr-none font-semibold'
                  : 'bg-slate-100/70 border-slate-200 text-slate-700 rounded-tl-none font-medium'
              }`}
            >
              {m.role === 'user' ? (
                <p className="whitespace-pre-line">{m.content}</p>
              ) : (
                <ReactMarkdown components={MD_COMPONENTS}>{m.content}</ReactMarkdown>
              )}
              {answerHasFixableIssues(m.toolCalls) && topInsights.length > 0 && (
                <div className="mt-2.5 pt-2.5 border-t border-slate-200 space-y-1.5">
                  {topInsights.map((insight) => {
                    const meta = SEVERITY_META[insight.severity] || SEVERITY_META.low;
                    const days = daysLabel(insight.evidence?.days_until_drop);
                    return (
                      <button
                        key={insight.id}
                        type="button"
                        onClick={() => document.getElementById('an-issues-found')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                        className="group w-full flex items-center gap-2 bg-white border border-slate-200 hover:border-indigo-300 hover:shadow-sm rounded-lg px-2.5 py-2 transition text-left cursor-pointer"
                      >
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: meta.color }} />
                        <span className="flex-1 min-w-0 text-[10.5px] font-bold text-slate-700 truncate">
                          {finding(insight, metricFor(insight.metric_key))}
                        </span>
                        {days && (
                          <span className="shrink-0 flex items-center gap-0.5 text-[9px] font-bold text-slate-400">
                            <Clock size={9} />
                            {days}
                          </span>
                        )}
                        <ArrowRight size={11} className="shrink-0 text-slate-300 group-hover:text-indigo-500 transition" />
                      </button>
                    );
                  })}
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
    </div>
  );
}
