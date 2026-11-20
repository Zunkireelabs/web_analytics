import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import AssistantMessage from './AssistantMessage.jsx';
import AssistantEvidence from './AssistantEvidence.jsx';
import NeedsYouCard from './NeedsYouCard.jsx';
import ShippingCard from './ShippingCard.jsx';
import { greeting } from '../lib/agent-greeting.js';
import Button from './Button.jsx';
import { Sparkles, X, ArrowUp, AlertTriangle, List, Maximize2, Minimize2 } from 'lucide-react';

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

// `raise` is what the assistant should open with (from useNeedsYou); `onRaised` tells the app it was shown.
export default function ClientAssistantPanel({ open, onClose, raise = [], onRaised, onResolved, ship, siteId }) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const [actions, setActions] = useState([]);
  const [generatingId, setGeneratingId] = useState(null);
  const [siteName, setSiteName] = useState(null);
  // The one-tap questions (top 15 in four groups, from get_suggested_questions). The fallback is the old short list.
  const [questions, setQuestions] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // A small popup by default; the client can make it bigger. Bigger is the exception, not the starting size.
  const [big, setBig] = useState(false);
  const scrollRef = useRef(null);

  // The conversation thread (and its DB-backed history) resets each time the
  // panel is opened fresh — deterministic capabilities re-read live state
  // regardless, and ask_growth_copilot always starts a new
  // copilot_conversations row when no conversationId is passed, so there is
  // no stale-transcript risk in starting clean per open.
  useEffect(() => { if (!open) { setMessages([]); setConversationId(null); setError(null); setActions([]); setMoreOpen(false); } }, [open]);

  useEffect(() => {
    if (!open || questions) return;
    api.assistant.invoke('get_suggested_questions').then((res) => { if (res.ok) setQuestions(res.data); }).catch(() => {});
  }, [open, questions]);

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

  // Shown once when the panel is open: record it so the same items are not raised again straight away.
  // The panel keeps its own copy, because `raise` empties once they are recorded as shown.
  const [shown, setShown] = useState([]);
  const hello = greeting(shown, ship); // the short "left for your approval" line at the top
  const shownRef = useRef(null);
  useEffect(() => {
    if (!open) { shownRef.current = null; setShown([]); return; }
    const sig = raise.map((i) => i.key).join('|');
    if (raise.length && shownRef.current !== sig) {
      shownRef.current = sig;
      setShown(raise);
      onRaised?.(raise);
    }
  }, [open, raise]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, asking]);

  const ask = async (question) => {
    const text = (question ?? input).trim();
    if (!text || asking) return;
    setInput('');
    setMoreOpen(false);
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
      <div className="fixed inset-0 z-40 bg-neutral-900/30 sm:hidden animate-fade-in" onClick={onClose} />

      <div className={`fixed z-50 bg-white flex flex-col overflow-hidden inset-0 sm:inset-auto sm:bottom-4 sm:right-4 sm:rounded-[18px] animate-fade-in transition-[width,height] duration-200 ${
          big ? 'sm:w-[560px] sm:h-[calc(100vh-32px)]' : 'sm:w-[380px] sm:h-[min(560px,calc(100vh-32px))]'}`}
        style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 24px 60px -12px rgba(0,0,0,.32)' }}
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
          <Button variant="ghost" size="sm" icon aria-label={big ? 'Make smaller' : 'Make bigger'} className="hidden sm:inline-flex" onClick={() => setBig((b) => !b)}>
            {big ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </Button>
          <Button variant="ghost" size="sm" icon aria-label="Close" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scrollbar-thin">
          {messages.length === 0 && hello && <p className="text-[13.5px] leading-5 text-text pt-0.5" data-agent-hello>{hello}</p>}

          {messages.length === 0 && ship && ['fixes', 'content'].some((k) => ship[k]?.step) && (
            <div className="pt-2 space-y-2.5">
              {['fixes', 'content'].filter((k) => ship[k]?.step).map((k) => (
                <div key={k}>
                  <div className="text-[11px] font-medium tracking-[.08em] uppercase text-faint mb-1.5">{k === 'fixes' ? 'Fixes' : 'Content'}</div>
                  <ShippingCard scope={k} state={ship[k]} siteId={siteId} onChanged={ship.reload} />
                </div>
              ))}
            </div>
          )}

          {messages.length === 0 && shown.length > 0 && (
            <div className="pt-2">
              <NeedsYouCard items={shown} onClose={onClose} onDone={onResolved} />
            </div>
          )}

          {messages.length === 0 && shown.length === 0 && (
            <div className="space-y-4 pt-2">
              <div>
                <p className="text-lg font-medium tracking-[-0.02em] text-fg">{siteName ? `Hi, ${siteName}` : 'Hi there'}</p>
                <p className="text-sm text-text mt-1">Ask anything about your site's search performance.</p>
              </div>
              <div className="space-y-2">
                {(questions ? questions.quick.map((t) => ({ text: t })) : STARTER_PROMPTS).map((q) => (
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

        {questions && (
          <div className="px-4 pt-2.5 shrink-0 border-t border-border-canvas">
            <div className="flex gap-1.5 overflow-x-auto pb-2 [scrollbar-width:none]">
              {questions.quick.map((q) => (
                <button key={q} type="button" onClick={() => ask(q)} disabled={asking}
                  className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium text-text bg-white hover:bg-muted disabled:opacity-50"
                  style={{ boxShadow: '0 0 0 1px var(--input)' }}>{q}</button>
              ))}
              <button type="button" onClick={() => setMoreOpen(true)}
                className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium text-primary-strong bg-primary-tint inline-flex items-center gap-1.5"
                style={{ boxShadow: '0 0 0 1px var(--primary-ring)' }}>
                <List size={12} />More questions · {questions.total}
              </button>
            </div>
          </div>
        )}

        {moreOpen && questions && (
          <div className="absolute inset-0 z-10 bg-white flex flex-col" role="dialog" aria-label="All questions">
            <div className="h-14 px-4 border-b border-border-canvas shrink-0 flex items-center gap-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg leading-tight">{questions.total} questions you can ask</div>
                <div className="text-xs text-faint leading-tight">Tap one, or type your own</div>
              </div>
              <Button variant="ghost" size="sm" icon aria-label="Close" onClick={() => setMoreOpen(false)}><X size={14} /></Button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {questions.groups.map((g) => (
                <div key={g.id}>
                  <div className="text-[11px] font-medium tracking-[.08em] uppercase text-faint mt-4 mb-2">{g.label}</div>
                  <div className="flex flex-col items-start gap-1.5">
                    {g.questions.map((q) => (
                      <button key={q} type="button" onClick={() => ask(q)}
                        className="text-left rounded-[12px] px-3 py-2 text-[13px] font-medium text-text bg-white hover:bg-muted"
                        style={{ boxShadow: '0 0 0 1px var(--input)' }}>{q}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="p-4 border-t border-border-canvas shrink-0">
          <div className="flex items-center gap-2 rounded-[10px] pl-3.5 pr-1.5 py-1.5 bg-white shadow-[0_0_0_1px_var(--input),0_1px_2px_rgba(0,0,0,.03)] focus-within:shadow-[0_0_0_1px_var(--primary),0_0_0_4px_var(--primary-tint)] transition-shadow">
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about your site…" disabled={asking}
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-fg placeholder:text-faint disabled:opacity-60" />
            <button type="submit" disabled={asking || !input.trim()}
              className="w-7 h-7 rounded-control bg-primary text-white grid place-items-center disabled:opacity-40 shrink-0" aria-label="Send message">
              <ArrowUp size={14} />
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
