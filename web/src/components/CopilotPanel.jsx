import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const STORAGE_KEY = 'copilot-conversation-id';

const STARTER_QUESTIONS = [
  'Why did traffic drop?',
  'What should I fix first?',
  "Summarize today's analysis.",
  'Which pages are easiest to improve?',
];

function Bubble({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed ${
        isUser ? 'text-white' : 'bg-slate-50 text-slate-800'
      }`} style={isUser ? { background: '#6C63FF' } : undefined}>
        <p className="whitespace-pre-line">{msg.content}</p>

        {!isUser && msg.cited_finding_ids?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2.5 pt-2.5 border-t border-slate-200/70">
            {msg.cited_finding_ids.slice(0, 5).map((id, i) => (
              <span key={id} title={id}
                className="text-[10px] font-semibold text-slate-400 bg-white border border-slate-200 rounded-full px-2 py-0.5">
                Evidence {i + 1}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// The primary way to interact with the platform, per spec — reachable from
// anywhere via the floating trigger, not tucked into one page. Never shows
// agent names in the conversation itself ("never expose internal agent
// complexity") — routing happens invisibly server-side.
export default function CopilotPanel({ open, onClose }) {
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? Number(stored) : null;
  });
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const [followUps, setFollowUps] = useState([]);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    if (!conversationId || messages.length) return;
    api.copilot.messages(conversationId).then((msgs) => { setMessages(msgs); }).catch(() => {
      // Stale/invalid stored id (e.g. wrong site) — start a fresh thread silently.
      localStorage.removeItem(STORAGE_KEY);
      setConversationId(null);
    });
  }, [open, conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, asking]);

  const ask = async (question) => {
    const text = (question ?? input).trim();
    if (!text || asking) return;
    setInput('');
    setError(null);
    setFollowUps([]);
    setMessages((m) => [...m, { role: 'user', content: text, created_at: new Date().toISOString() }]);
    setAsking(true);
    try {
      const res = await api.copilot.ask(conversationId, text);
      if (!conversationId) {
        setConversationId(res.conversationId);
        localStorage.setItem(STORAGE_KEY, String(res.conversationId));
      }
      setMessages((m) => [...m, {
        role: 'assistant', content: res.answer, created_at: new Date().toISOString(),
        cited_finding_ids: (res.citedFindings || []).map((f) => f.id),
      }]);
      setFollowUps(res.followUps || []);
    } catch (e) {
      setError(e.message || 'Something went wrong — try again.');
      setMessages((m) => m.slice(0, -1)); // drop the optimistic user bubble on failure
    } finally {
      setAsking(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-[1px] z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 h-full w-full sm:w-[420px] bg-white z-50 shadow-2xl flex flex-col fade-up"
        role="dialog" aria-label="AI Copilot">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg grid place-items-center text-white text-sm shrink-0"
              style={{ background: '#6C63FF' }}>✦</span>
            <div>
              <div className="text-sm font-bold text-slate-900">AI Copilot</div>
              <div className="text-[11px] text-slate-400">Ask anything about your site</div>
            </div>
          </div>
          <button onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-xl leading-none w-8 h-8 rounded-lg hover:bg-slate-50
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]"
            aria-label="Close">×</button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {messages.length === 0 && (
            <div className="space-y-2.5 pt-2">
              <p className="text-[13px] text-slate-400 mb-3">Try asking:</p>
              {STARTER_QUESTIONS.map((q) => (
                <button key={q} onClick={() => ask(q)}
                  className="block w-full text-left text-[13px] text-slate-600 bg-slate-50 hover:bg-slate-100
                             rounded-xl px-3.5 py-2.5 transition focus-visible:outline focus-visible:outline-2
                             focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]">
                  {q}
                </button>
              ))}
            </div>
          )}
          {messages.map((m, i) => <Bubble key={i} msg={m} />)}
          {asking && (
            <div className="flex justify-start">
              <div className="bg-slate-50 rounded-2xl px-4 py-3 flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '120ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '240ms' }} />
              </div>
            </div>
          )}
          {error && <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</p>}
        </div>

        {followUps.length > 0 && !asking && (
          <div className="px-5 pb-2 flex flex-wrap gap-1.5 shrink-0">
            {followUps.map((q) => (
              <button key={q} onClick={() => ask(q)}
                className="text-[11.5px] font-medium text-[#6C63FF] bg-[#6C63FF]/8 hover:bg-[#6C63FF]/14
                           rounded-full px-3 py-1.5 transition">
                {q}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="p-4 border-t border-slate-100 shrink-0 flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your site…"
            disabled={asking}
            className="flex-1 text-[13.5px] border border-slate-200 rounded-xl px-3.5 py-2.5
                       focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/30 disabled:opacity-60"
          />
          <button type="submit" disabled={asking || !input.trim()}
            className="shrink-0 text-sm font-semibold text-white rounded-xl px-4 disabled:opacity-40
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]"
            style={{ background: '#6C63FF' }}>
            Ask
          </button>
        </form>
      </div>
    </>
  );
}
