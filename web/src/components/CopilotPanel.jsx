import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { 
  Sparkles, 
  Send, 
  X, 
  Bot, 
  CornerDownLeft, 
  Compass, 
  TrendingDown, 
  Zap, 
  FileText, 
  Award,
  AlertTriangle,
  ArrowRight,
  ShieldCheck
} from 'lucide-react';

const STORAGE_KEY = 'copilot-conversation-id';

const STARTER_CARDS = [
  { text: 'Why did traffic drop?', desc: 'Detect anomalies', icon: TrendingDown, color: '#f43f5e', bg: 'from-rose-50 to-rose-100/30' },
  { text: 'What should I fix first?', desc: 'Prioritize tasks', icon: Zap, color: '#eab308', bg: 'from-amber-50 to-amber-100/30' },
  { text: "Summarize today's logs.", desc: 'Active overview', icon: FileText, color: '#8b5cf6', bg: 'from-violet-50 to-violet-100/30' },
  { text: 'Which pages have wins?', desc: 'Quick SEO gains', icon: Award, color: '#0ea5e9', bg: 'from-sky-50 to-sky-100/30' },
];

function Bubble({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in`}>
      {!isUser && (
        <span className="w-8 h-8 rounded-2xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 text-white grid place-items-center shrink-0 shadow-md shadow-indigo-500/10 border border-white/20">
          <Bot size={13} />
        </span>
      )}
      <div className={`max-w-[78%] rounded-[20px] px-4 py-3 text-[13px] leading-relaxed shadow-sm relative border ${
        isUser 
          ? 'text-white bg-gradient-to-br from-indigo-650 via-indigo-500 to-violet-500 border-indigo-500/30 rounded-tr-none' 
          : 'bg-white/80 border-slate-200/60 text-slate-800 rounded-tl-none'
      }`}>
        <p className="whitespace-pre-line font-medium">{msg.content}</p>

        {!isUser && msg.cited_finding_ids?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3 pt-2.5 border-t border-slate-150">
            {msg.cited_finding_ids.slice(0, 5).map((id, i) => (
              <span key={id} title={id}
                className="text-[9px] font-black uppercase tracking-wider text-slate-450 bg-slate-50 border border-slate-200/50 rounded-full px-2 py-0.5">
                Evidence {i + 1}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

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
      setMessages((m) => m.slice(0, -1));
    } finally {
      setAsking(false);
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Dim overlay with blur */}
      <div className="fixed inset-0 bg-slate-900/10 backdrop-blur-[2px] z-40 animate-fade-in" onClick={onClose} />
      
      {/* Floating 3D Panel */}
      <div className="fixed inset-y-0 right-0 sm:inset-y-4 sm:right-4 w-full sm:w-[420px] bg-slate-50/95 backdrop-blur-xl z-50 sm:rounded-[32px] border border-slate-200/80 shadow-[0_24px_64px_-12px_rgba(99,102,241,0.18)] flex flex-col overflow-hidden animate-slide-left"
        role="dialog" aria-label="AI Copilot">
        
        {/* Glowing aura at top */}
        <div aria-hidden className="absolute -top-24 left-1/4 w-48 h-48 rounded-full blur-[70px] bg-indigo-500/20 pointer-events-none" />

        {/* Panel Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-slate-200/50 shrink-0 bg-white/60 relative z-10">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white grid place-items-center shadow-lg shadow-indigo-500/15 border border-white/10 shrink-0">
              <Sparkles size={15} className="animate-pulse" />
            </span>
            <div>
              <div className="text-xs font-black text-slate-800 uppercase tracking-widest flex items-center gap-1.5 leading-none">
                <span>Growth Copilot</span>
                <span className="inline-flex w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
              </div>
              <div className="text-[9px] font-bold text-slate-400 mt-1 uppercase tracking-wide">AI Platform Intelligence</div>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="w-10 h-10 rounded-full border border-slate-200/60 hover:border-slate-350 grid place-items-center text-slate-400 hover:text-slate-700 hover:bg-white shadow-sm transition active:scale-95 focus:outline-none"
            aria-label="Close"
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>

        {/* Conversation Viewport */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-4 scrollbar-thin relative z-10">
          
          {messages.length === 0 && (
            <div className="space-y-4 pt-2">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1">
                <Compass size={11} className="text-indigo-500" />
                <span>Select Starter Prompt</span>
              </div>
              
              {/* 2x2 grid for starter questions */}
              <div className="grid grid-cols-2 gap-3">
                {STARTER_CARDS.map((q) => {
                  const Icon = q.icon;
                  return (
                    <button 
                      key={q.text} 
                      onClick={() => ask(q.text)}
                      className={`text-left bg-gradient-to-br ${q.bg} hover:scale-[1.02] border border-slate-200/60 hover:border-slate-300 rounded-2xl p-4.5 transition-all duration-200 flex flex-col justify-between min-h-[110px] shadow-sm hover:shadow-md focus:outline-none group`}
                    >
                      <span className="w-7 h-7 rounded-xl bg-white border border-slate-200/50 grid place-items-center shadow-sm shrink-0" style={{ color: q.color }}>
                        <Icon size={13} strokeWidth={2.5} />
                      </span>
                      <div className="mt-3">
                        <div className="text-[11.5px] font-extrabold text-slate-800 leading-snug group-hover:text-indigo-655 transition">{q.text}</div>
                        <div className="text-[9px] text-slate-450 font-bold mt-0.5 leading-none">{q.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {messages.map((m, i) => <Bubble key={i} msg={m} />)}
          
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

        {/* Context-aware suggestions */}
        {followUps.length > 0 && !asking && (
          <div className="px-6 pb-3 flex flex-wrap gap-1.5 shrink-0 bg-gradient-to-t from-slate-50 via-slate-50 to-transparent relative z-10">
            {followUps.map((q) => (
              <button 
                key={q} 
                onClick={() => ask(q)}
                className="text-[10px] font-black uppercase tracking-wider text-indigo-650 bg-white border border-slate-200/80 hover:border-slate-300 rounded-xl px-3 py-2 transition active:scale-95 focus:outline-none shadow-sm"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {/* Input Bar Form */}
        <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="p-4 border-t border-slate-200/50 shrink-0 bg-white relative z-10 flex items-center gap-2">
          <div className="flex-1 relative flex items-center">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your site…"
              disabled={asking}
              className="w-full text-xs font-semibold border border-slate-200/80 rounded-2xl pl-4 pr-12 py-3 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500 disabled:opacity-60 transition duration-150 text-slate-800 placeholder:text-slate-400"
            />
            {input.trim() && (
              <span className="absolute right-3 text-[8px] font-black uppercase text-slate-400 tracking-wider font-mono flex items-center gap-0.5 border border-slate-200 bg-white rounded-lg px-1.5 py-0.5 pointer-events-none">
                <CornerDownLeft size={8} />
              </span>
            )}
          </div>
          <button 
            type="submit" 
            disabled={asking || !input.trim()}
            className="w-10 h-10 rounded-2xl grid place-items-center text-white transition active:scale-95 disabled:opacity-40 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500 shrink-0"
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
