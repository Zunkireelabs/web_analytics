import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import AssistantMessage from './AssistantMessage.jsx';
import AssistantEvidence from './AssistantEvidence.jsx';
import {
  Sparkles, Send, Bot, AlertTriangle, X, Compass,
  TrendingUp, ShieldAlert, Activity, ListChecks, Hammer,
} from 'lucide-react';

// The staff-only Admin Assistant for /analyst — one chat that answers
// operational questions (why didn't this ship, run today's safe fixes) via
// server/assistant/'s capability registry, AND anything about the client's
// real data — traffic, findings, keywords — via
// server/assistant/assistant.js's tryDataFallback, which routes whatever the
// deterministic intent classifier doesn't recognize to the findings-routing
// engine (ask_growth_copilot) first, then the data-analyst-agent's deeper
// stats/forecast tools (ask_analyst_data, platform_admin-only) if that comes
// up empty. Replaces the old AnalystChatPanel, which only ever reached the
// analyst service directly.
//
// No Generate Draft button here (unlike ClientAssistantPanel) — the
// underlying /action-center/generate route scopes to the admin's OWN session
// site, not whichever `clientId` this page has selected, so wiring it in
// would risk drafting against the wrong tenant. Evidence is shown for
// context only until that route gains a real admin site override.
//
// `clientId` scopes every call via ?siteId= — the same override
// routes/assistant.js's resolveContext already grants a platform_admin, and
// exactly the site this page's own picker has selected, so there is no
// separate in-chat site switcher to keep in sync.
const STARTER_PROMPTS = [
  { text: 'Which keywords are closest to page 1?', desc: 'Fastest wins', icon: TrendingUp, color: '#059669', bg: 'from-emerald-50 to-emerald-100/30' },
  { text: "What's putting impressions at risk?", desc: 'Early warnings', icon: ShieldAlert, color: '#dc2626', bg: 'from-rose-50 to-rose-100/30' },
  { text: 'What do you need from me?', desc: 'Pending decisions', icon: ListChecks, color: '#6C63FF', bg: 'from-violet-50 to-violet-100/30' },
  { text: "Run today's safe fixes", desc: 'Ship what\'s ready', icon: Hammer, color: '#d97706', bg: 'from-amber-50 to-amber-100/30' },
];

export default function AdminAssistantPanel({ clientId, onClose }) {
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const [actions, setActions] = useState([]);
  const [siteName, setSiteName] = useState(null);
  const scrollRef = useRef(null);

  // Conversation is scoped to one client — carrying it across a client switch
  // would attach answers about site A to site B.
  useEffect(() => { setMessages([]); setConversationId(null); setError(null); setActions([]); setInput(''); setSiteName(null); }, [clientId]);

  // Real per-client name for the greeting ("Hi, Admizz Education") — the
  // same get_onboarding_status capability the client Assistant uses,
  // invoked with this page's ?siteId= override rather than the admin's own
  // session site.
  useEffect(() => {
    if (!clientId) return;
    api.assistant.invoke('get_onboarding_status', {}, clientId).then((res) => {
      if (res.ok) setSiteName(res.data.site.name);
    }).catch(() => {});
  }, [clientId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, asking]);

  const ask = async (question) => {
    const text = (question ?? input).trim();
    if (!text || asking) return;
    setInput('');
    setError(null);
    setActions([]);
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setAsking(true);
    try {
      const res = await api.assistant.message(text, conversationId, clientId);
      if (res.data?.conversationId) setConversationId(res.data.conversationId);
      setMessages((m) => [...m, { role: 'assistant', content: res.message, citedFindings: res.data?.citedFindings || [] }]);
      setActions(res.actions || []);
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
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-800">Admin Assistant</h2>
          <p className="text-[11px] font-medium text-slate-500">Operations and performance for this client — ask anything</p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close chat"
            className="relative w-8 h-8 rounded-full border border-slate-200 bg-white grid place-items-center text-slate-400 hover:text-slate-700 hover:border-slate-300 transition shrink-0 shadow-sm">
            <X size={14} />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-[16rem]">
        {messages.length === 0 && (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200/60 rounded-2xl p-4 shadow-sm">
              <p className="text-[12.5px] font-extrabold text-slate-800 leading-snug">
                {siteName ? `Hi, ${siteName} 👋 — how can I help today?` : 'Hi — how can I help with this client today?'}
              </p>
              <p className="text-[10.5px] font-medium text-slate-400 mt-1 leading-relaxed">
                Ask about onboarding, pending decisions, agent activity, or performance and forecasts.
              </p>
            </div>

            <div className="flex items-center gap-1.5">
              <Compass size={11} className="text-slate-400" />
              <span className="an-label">Select starter prompt</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {STARTER_PROMPTS.map((q) => {
                const Icon = q.icon;
                return (
                  <button key={q.text} type="button" onClick={() => ask(q.text)}
                    className={`group text-left bg-gradient-to-br ${q.bg} hover:scale-[1.02] border border-slate-200/60 hover:border-slate-300 rounded-2xl p-3.5 transition-all duration-200 flex flex-col justify-between min-h-[92px] shadow-sm hover:shadow-md`}>
                    <span className="w-7 h-7 rounded-xl bg-white border border-slate-200/50 grid place-items-center shadow-sm shrink-0" style={{ color: q.color }}>
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
            <div className={`${m.role === 'user' ? 'max-w-[85%]' : 'max-w-[92%]'} rounded-2xl px-3.5 py-2.5 text-[11px] leading-relaxed border ${
              m.role === 'user'
                ? 'bg-indigo-600 text-white border-indigo-500 rounded-tr-none font-semibold'
                : 'bg-slate-100/70 border-slate-200 text-slate-700 rounded-tl-none font-medium'
            }`}>
              {m.role === 'user' ? <p className="whitespace-pre-line">{m.content}</p> : <AssistantMessage content={m.content} />}
              {m.role !== 'user' && <AssistantEvidence findings={m.citedFindings} />}
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
                <span key={d} className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />
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

      {actions.length > 0 && !asking && (
        <div className="px-5 pb-2 flex flex-wrap gap-1.5 shrink-0">
          {actions.map((a) => (
            <button key={a.id + (a.subject || '')} type="button" onClick={() => ask(a.label)}
              className="text-[10px] font-black uppercase tracking-wider text-indigo-650 bg-white border border-slate-200/80 hover:border-slate-300 rounded-xl px-3 py-2 transition active:scale-95 shadow-sm">
              {a.label}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="px-5 py-3 border-t border-slate-200 shrink-0 flex items-center gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about this client…" disabled={asking}
          className="an-input flex-1 text-[11px] font-semibold py-2.5" />
        <button type="submit" disabled={asking || !input.trim()} aria-label="Send message"
          className="an-grad-btn w-9 h-9 rounded-xl grid place-items-center text-white shrink-0">
          <Send size={12} />
        </button>
      </form>
    </div>
  );
}
