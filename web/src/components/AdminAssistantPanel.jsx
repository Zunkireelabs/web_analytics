import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import AssistantMessage from './AssistantMessage.jsx';
import AssistantEvidence from './AssistantEvidence.jsx';
import Button from './Button.jsx';
import { Sparkles, ArrowUp, AlertTriangle, X } from 'lucide-react';

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
  { text: 'Which keywords are closest to page 1?', desc: 'Fastest wins' },
  { text: "What's putting impressions at risk?", desc: 'Early warnings' },
  { text: 'What do you need from me?', desc: 'Pending decisions' },
  { text: "Run today's safe fixes", desc: "Ship what's ready" },
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
      <div className="h-14 px-4 border-b border-border-canvas shrink-0 flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0"
          style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg leading-tight">Admin assistant</div>
          <div className="text-xs text-faint leading-tight truncate">Operations and performance for this client</div>
        </div>
        {onClose && (
          <Button variant="ghost" size="sm" icon aria-label="Close chat" onClick={onClose}>
            <X size={14} />
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-[16rem]">
        {messages.length === 0 && (
          <div className="space-y-4 pt-2">
            <div>
              <p className="text-lg font-medium tracking-[-0.02em] text-fg">
                {siteName ? `Hi, ${siteName}` : 'Hi there'}
              </p>
              <p className="text-sm text-text mt-1">
                Ask about onboarding, pending decisions, agent activity, or performance and forecasts.
              </p>
            </div>
            <div className="space-y-2">
              {STARTER_PROMPTS.map((q) => (
                <button key={q.text} type="button" onClick={() => ask(q.text)}
                  className="w-full text-left rounded-[10px] px-3.5 py-3 text-sm hover:bg-[#fafafa] cursor-pointer"
                  style={{ boxShadow: '0 0 0 1px var(--border-canvas)' }}>
                  <div className="text-fg">{q.text}</div>
                  <div className="text-xs text-faint mt-0.5">{q.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="ml-auto max-w-[85%] rounded-xl bg-muted px-3.5 py-2.5 text-sm">
                <p className="whitespace-pre-line">{m.content}</p>
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-start">
              <div className="text-sm leading-[22px] text-fg min-w-0 max-w-full">
                <AssistantMessage content={m.content} />
                <AssistantEvidence findings={m.citedFindings} />
              </div>
            </div>
          )
        ))}

        {asking && (
          <div className="flex justify-start">
            <div className="flex gap-1.5 items-center py-2">
              {[0, 120, 240].map((d) => (
                <span key={d} className="w-1.5 h-1.5 rounded-full bg-faint-2 animate-bounce" style={{ animationDelay: `${d}ms` }} />
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2.5 flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {actions.length > 0 && !asking && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5 shrink-0">
          {actions.map((a) => (
            <Button key={a.id + (a.subject || '')} variant="light" size="sm" onClick={() => ask(a.label)}>
              {a.label}
            </Button>
          ))}
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="p-4 border-t border-border-canvas shrink-0">
        <div className="flex items-center gap-2 rounded-[10px] pl-3.5 pr-1.5 py-1.5 bg-white shadow-[0_0_0_1px_var(--input),0_1px_2px_rgba(0,0,0,.03)] focus-within:shadow-[0_0_0_1px_var(--primary),0_0_0_4px_var(--primary-tint)] transition-shadow">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about this client…" disabled={asking}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-fg placeholder:text-faint disabled:opacity-60" />
          <button type="submit" disabled={asking || !input.trim()} aria-label="Send message"
            className="w-7 h-7 rounded-control bg-primary text-white grid place-items-center disabled:opacity-40 shrink-0 cursor-pointer">
            <ArrowUp size={14} />
          </button>
        </div>
      </form>
    </div>
  );
}
