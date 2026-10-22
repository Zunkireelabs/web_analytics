import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import AssistantMessage from './AssistantMessage.jsx';
import AssistantEvidence from './AssistantEvidence.jsx';
import Button from './Button.jsx';
import { Sparkles, X, ArrowUp, AlertTriangle } from 'lucide-react';

// The client-facing Assistant — replaces the old Growth Copilot bubble.
// Talks to server/assistant/ (routes/assistant.js): the deterministic
// onboarding/decision capabilities for "how's setup going, what needs my
// decision, run today's safe fixes", AND — via
// server/assistant/assistant.js's tryDataFallback — the former standalone
// Growth Copilot's findings-routing engine for anything else ("why did
// traffic drop", "which pages have wins"), complete with cited evidence and
// a Generate Draft action. One assistant, both jobs.
const STARTER_PROMPTS = [
  { text: "How's onboarding going?", desc: 'Site status' },
  { text: 'Why did my traffic drop?', desc: 'Diagnose an issue' },
  { text: 'Run today\'s safe fixes', desc: 'Ship what\'s ready' },
  { text: 'What do you need from me?', desc: 'Pending decisions' },
];

function Bubble({ msg, onGenerateDraft, generatingId }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in`}>
      {isUser ? (
        <div className="ml-auto max-w-[85%] rounded-xl bg-muted px-3.5 py-2.5 text-sm">
          <p className="whitespace-pre-line">{msg.content}</p>
        </div>
      ) : (
        <div className="text-sm leading-[22px] text-fg min-w-0">
          <AssistantMessage content={msg.content} />
          <AssistantEvidence findings={msg.citedFindings} onGenerateDraft={onGenerateDraft} generatingId={generatingId} />
        </div>
      )}
    </div>
  );
}

export default function ClientAssistantPanel({ open, onClose }) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const [actions, setActions] = useState([]);
  const [generatingId, setGeneratingId] = useState(null);
  const [siteName, setSiteName] = useState(null);
  const scrollRef = useRef(null);

  // The conversation thread (and its DB-backed history) resets each time the
  // panel is opened fresh — deterministic capabilities re-read live state
  // regardless, and ask_growth_copilot always starts a new
  // copilot_conversations row when no conversationId is passed, so there is
  // no stale-transcript risk in starting clean per open.
  useEffect(() => { if (!open) { setMessages([]); setConversationId(null); setError(null); setActions([]); } }, [open]);

  // Which site this is, so the greeting says "Hi, Zunkiree Labs" rather than
  // a generic line — the same get_onboarding_status capability the deterministic
  // 'status' intent already uses, just invoked directly instead of through a
  // chat message. Session-scoped (no siteId override), so this is always the
  // real site this tenant session belongs to.
  useEffect(() => {
    if (!open || siteName) return;
    api.assistant.invoke('get_onboarding_status').then((res) => {
      if (res.ok) setSiteName(res.data.site.name);
    }).catch(() => {});
  }, [open, siteName]);

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
      const res = await api.assistant.message(text, conversationId);
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

  // Same generator call Action Center's own "Generate Draft" button makes,
  // then the same ?openDraft= deep link NotificationBell already relies on.
  const generateFromChat = async (finding) => {
    if (!finding.actionable || generatingId) return;
    setGeneratingId(finding.id);
    setError(null);
    try {
      const { generatorId, params, tag, source } = finding.actionable;
      const draft = await api.actionCenter.generate(generatorId, params, source || 'assistant', finding.id);
      onClose();
      navigate(`/action-center?openDraft=${draft.id}`);
    } catch (e) {
      setError(`${finding.actionable.tag || 'Draft'}: ${e.message || 'Generation failed'}`);
    } finally {
      setGeneratingId(null);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-neutral-900/30 xl:hidden animate-fade-in" onClick={onClose} />

      <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[400px] bg-white border-l border-border-canvas flex flex-col overflow-hidden animate-slide-left xl:animate-none xl:sticky xl:top-0 xl:h-screen xl:z-auto xl:shrink-0"
        role="dialog" aria-label="Growth Assistant">

        <div className="h-14 px-4 border-b border-border-canvas shrink-0 flex items-center gap-2.5">
          <span className="w-7 h-7 rounded-control bg-primary-tint text-primary grid place-items-center shrink-0"
            style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>
            <Sparkles size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg leading-tight">Agent</div>
            <div className="text-xs text-faint leading-tight">Your site, in plain language</div>
          </div>
          <Button variant="ghost" size="sm" icon aria-label="Close" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-4 scrollbar-thin">
          {messages.length === 0 && (
            <div className="space-y-4 pt-2">
              <div>
                <p className="text-xl font-medium tracking-[-0.02em] text-fg">{siteName ? `Hi, ${siteName}` : 'Hi there'}</p>
                <p className="text-sm text-text mt-1">Ask anything about your site's search performance.</p>
              </div>
              <div className="space-y-2">
                {STARTER_PROMPTS.map((q) => (
                  <button key={q.text} onClick={() => ask(q.text)}
                    className="w-full text-left rounded-[10px] px-3.5 py-3 text-sm hover:bg-[#fafafa]"
                    style={{ boxShadow: '0 0 0 1px var(--border-canvas)' }}>
                    <div className="text-fg">{q.text}</div>
                    <div className="text-xs text-faint mt-0.5">{q.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => <Bubble key={i} msg={m} onGenerateDraft={generateFromChat} generatingId={generatingId} />)}

          {asking && (
            <div className="flex justify-start">
              <div className="flex gap-1.5 items-center py-2">
                <span className="w-1.5 h-1.5 rounded-full bg-faint-2 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-faint-2 animate-bounce" style={{ animationDelay: '120ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-faint-2 animate-bounce" style={{ animationDelay: '240ms' }} />
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
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about your site…" disabled={asking}
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-fg placeholder:text-faint disabled:opacity-60" />
            <button type="submit" disabled={asking || !input.trim()}
              className="w-[30px] h-[30px] rounded-control bg-primary text-white grid place-items-center disabled:opacity-40 shrink-0" aria-label="Send message">
              <ArrowUp size={14} />
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
