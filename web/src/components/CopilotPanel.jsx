import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  ShieldCheck,
  Target,
  Globe,
  BrainCircuit,
  AlertCircle
} from 'lucide-react';

const STORAGE_KEY = 'copilot-conversation-id';

const STARTER_CARDS = [
  { text: 'Why did traffic drop?', desc: 'Detect anomalies', icon: TrendingDown, color: '#f43f5e', bg: 'from-rose-50 to-rose-100/30' },
  { text: 'What should I fix first?', desc: 'Prioritize tasks', icon: Zap, color: '#eab308', bg: 'from-amber-50 to-amber-100/30' },
  { text: "Summarize today's logs.", desc: 'Active overview', icon: FileText, color: '#8b5cf6', bg: 'from-violet-50 to-violet-100/30' },
  { text: 'Which pages have wins?', desc: 'Quick SEO gains', icon: Award, color: '#0ea5e9', bg: 'from-sky-50 to-sky-100/30' },
];

const EVIDENCE_LABEL = {
  page: 'Page Route', impressions: 'Impressions Count', clicks: 'Clicks Count', avgPosition: 'Avg. Position',
  score: 'Audit Score', country: 'Country', city: 'City', device: 'Target Device', query: 'Search Query',
  language: 'Target Language', recent: 'Recent Period Clicks', prior: 'Prior Period Clicks', delta: 'Click Delta', ctr: 'Average CTR',
  ctrDeviationPct: 'CTR Variance %', gapType: 'Gap Type', detail: 'Technical Details', entity: 'Identified Entity',
  competitorsWithThisFeature: 'Competitors with citation', competitorsTracked: 'Competitors Tracked',
  agentName: 'Assigned Agent', confidence: 'LLM Confidence Score', estimate: 'Expected Return basis',
};

function getFindingHeadline(f) {
  if (f.actionable?.tag) return f.actionable.tag;
  if (f.evidence?.gapType) return f.evidence.gapType;
  if (f.id?.includes(':low-ctr:')) return `Low CTR (${f.evidence?.device || 'Device'})`;
  if (f.id?.includes(':declining:')) return `Declining Traffic (${f.evidence?.device || 'Device'})`;
  if (f.id?.includes('query-intelligence:dropper:')) return 'Query Impressions Drop';
  if (f.id?.includes('seo:')) return 'SEO Diagnostic';
  if (f.id?.includes('performance:')) return 'Performance Issue';
  
  const parts = f.id?.split(':') || [];
  const name = parts[parts.length - 1] || 'SEO Finding';
  return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function getEvidenceIcon(id) {
  if (id?.startsWith('query-intelligence') || id?.includes('seo:')) return Target;
  if (id?.startsWith('geo')) return Globe;
  if (id?.startsWith('content')) return FileText;
  if (id?.startsWith('executive')) return BrainCircuit;
  return AlertCircle;
}

function renderTextWithEnhancements(text) {
  if (!text) return null;
  const regex = /(https?:\/\/[^\s\)]+)|("[^"]+")/g;
  const parts = text.split(regex);
  return parts.map((part, i) => {
    if (part === undefined || part === '') return null;
    
    if (part.startsWith('http://') || part.startsWith('https://')) {
      const url = part;
      let label = url;
      try {
        const parsedUrl = new URL(url);
        label = parsedUrl.pathname === '/' ? parsedUrl.hostname : parsedUrl.pathname;
        if (label.length > 30) {
          label = label.slice(0, 12) + '...' + label.slice(-15);
        }
      } catch (e) {}
      
      return (
        <a 
          key={i} 
          href={url} 
          target="_blank" 
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-650 hover:text-indigo-800 bg-indigo-50 border border-indigo-100/50 hover:border-indigo-200 rounded-lg px-2 py-0.5 mx-0.5 transition-colors focus:outline-none"
        >
          <Compass size={10} className="shrink-0" />
          {label}
        </a>
      );
    }
    
    if (part.startsWith('"') && part.endsWith('"')) {
      const cleanVal = part.slice(1, -1);
      let badgeStyle = "bg-slate-100 text-slate-700 border-slate-200/65";
      if (cleanVal === 'NEEDS_IMPROVEMENT') {
        badgeStyle = "bg-rose-50 text-rose-600 border-rose-100";
      } else if (cleanVal === 'POOR') {
        badgeStyle = "bg-rose-100 text-rose-700 border-rose-200/50";
      } else if (cleanVal === 'GOOD') {
        badgeStyle = "bg-emerald-50 text-emerald-600 border-emerald-100";
      }
      
      return (
        <code 
          key={i} 
          className={`inline-block text-[11px] font-extrabold px-1.5 py-0.5 rounded border leading-none font-mono ${badgeStyle} mx-0.5`}
        >
          {cleanVal}
        </code>
      );
    }
    
    return <span key={i}>{part}</span>;
  });
}

function parseMessageContent(text) {
  if (!text) return { intro: '', items: [] };

  const firstListIndex = text.search(/(?:^|\n)\d+\.\s+/);
  let intro = text;
  let items = [];

  if (firstListIndex !== -1) {
    intro = text.slice(0, firstListIndex).trim();
    const listPart = text.slice(firstListIndex);
    const matches = [...listPart.matchAll(/(?:^|\n)(\d+)\.\s+([\s\S]*?)(?=(?:\n\d+\.\s+)|$)/g)];
    
    items = matches.map(match => {
      const num = match[1];
      const rawContent = match[2].trim();
      
      const dotIndex = rawContent.indexOf('. ');
      let header = rawContent;
      let description = '';
      
      if (dotIndex !== -1) {
        header = rawContent.slice(0, dotIndex).trim();
        description = rawContent.slice(dotIndex + 1).trim();
      } else {
        const colonIndex = rawContent.indexOf(': ');
        if (colonIndex !== -1) {
          header = rawContent.slice(0, colonIndex).trim();
          description = rawContent.slice(colonIndex + 1).trim();
        }
      }

      return { num, header, description };
    });
  }

  return { intro, items };
}

function FormattedMessage({ content }) {
  const { intro, items } = parseMessageContent(content);
  
  if (items.length === 0) {
    return (
      <p className="whitespace-pre-line font-medium text-slate-800 leading-relaxed">
        {renderTextWithEnhancements(content)}
      </p>
    );
  }
  
  return (
    <div className="space-y-3">
      {intro && (
        <p className="whitespace-pre-line font-medium text-slate-800 leading-relaxed">
          {renderTextWithEnhancements(intro)}
        </p>
      )}
      <div className="flex flex-col gap-3.5 mt-2">
        {items.map((item, index) => (
          <div 
            key={index} 
            className="p-3.5 rounded-2xl border border-slate-200/60 bg-slate-50/50 hover:bg-white hover:border-indigo-200 hover:shadow-md transition-all duration-300 group flex gap-3 items-start"
          >
            <div className="w-6 h-6 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-650 grid place-items-center text-[11px] font-black shrink-0 group-hover:bg-indigo-600 group-hover:text-white group-hover:border-indigo-650 transition-colors">
              {item.num}
            </div>
            <div className="flex-1 min-w-0">
              <h5 className="text-[12.5px] font-black text-slate-850 leading-snug group-hover:text-indigo-650 transition-colors">
                {item.header}
              </h5>
              {item.description && (
                <p className="text-[11.5px] font-semibold text-slate-500 leading-relaxed mt-1.5">
                  {renderTextWithEnhancements(item.description)}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Bubble({ msg, onGenerateDraft, generatingId }) {
  const isUser = msg.role === 'user';
  const [activeEvidenceIndex, setActiveEvidenceIndex] = useState(null);
  
  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in`}>
      {!isUser && (
        <span className="w-8 h-8 rounded-2xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 text-white grid place-items-center shrink-0 shadow-md shadow-indigo-500/10 border border-white/20">
          <Bot size={13} />
        </span>
      )}
      <div className={`max-w-[85%] rounded-[20px] px-4 py-3 text-[13px] leading-relaxed shadow-sm relative border ${
        isUser
          ? 'text-white bg-gradient-to-br from-indigo-650 via-indigo-500 to-violet-500 border-indigo-500/30 rounded-tr-none'
          : 'bg-white/80 border-slate-200/60 text-slate-800 rounded-tl-none'
      }`}>
        {isUser ? (
          <p className="whitespace-pre-line font-medium">{msg.content}</p>
        ) : (
          <FormattedMessage content={msg.content} />
        )}

        {!isUser && msg.cited_findings?.length > 0 && (
          <div className="mt-4 pt-3.5 border-t border-slate-100 flex flex-col gap-3">
            <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-400">
              <Eye size={11} className="text-indigo-500 animate-pulse" />
              <span>Supporting Evidence ({msg.cited_findings.length})</span>
            </div>
            
            <div className="flex flex-wrap gap-2">
              {msg.cited_findings.slice(0, 5).map((f, i) => {
                const headline = getFindingHeadline(f);
                const Icon = getEvidenceIcon(f.id);
                const isActive = activeEvidenceIndex === i;
                
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setActiveEvidenceIndex(isActive ? null : i)}
                    className={`flex items-center gap-1.5 text-[10.5px] font-bold px-3 py-1.5 rounded-xl border transition-all duration-200 active:scale-95 focus:outline-none cursor-pointer ${
                      isActive
                        ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm shadow-indigo-600/20'
                        : 'bg-slate-50 border-slate-200/70 hover:border-slate-350 text-slate-655 hover:text-slate-800'
                    }`}
                  >
                    <Icon size={11} className={isActive ? 'text-white' : 'text-slate-400'} />
                    <span>{headline}</span>
                    <span className={`text-[9px] opacity-60 font-medium ${isActive ? 'text-white' : 'text-slate-450'}`}>
                      #{i + 1}
                    </span>
                  </button>
                );
              })}
            </div>
            
            {activeEvidenceIndex !== null && msg.cited_findings[activeEvidenceIndex] && (() => {
              const f = msg.cited_findings[activeEvidenceIndex];
              const evidenceEntries = Object.entries(f.evidence || {}).filter(
                ([k, v]) => v != null && v !== '' && k !== 'whyItMatters'
              );
              
              return (
                <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-2xl animate-slide-down flex flex-col gap-3 shadow-inner">
                  <div>
                    <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1">
                      Why This Matters
                    </div>
                    <p className="text-[11.5px] font-medium text-slate-600 leading-relaxed italic">
                      "{f.whyItMatters || 'This issue was detected during active intelligence monitoring.'}"
                    </p>
                  </div>
                  
                  {evidenceEntries.length > 0 && (
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1.5">
                        Key Parameters & Metrics
                      </div>
                      <div className="grid grid-cols-2 gap-2 bg-white border border-slate-150 rounded-xl p-2.5">
                        {evidenceEntries.map(([k, v]) => (
                          <div key={k} className="flex justify-between items-center text-[10px] border-b border-slate-50 last:border-0 pb-1 last:pb-0">
                            <span className="text-slate-450 font-bold">{EVIDENCE_LABEL[k] || k}</span>
                            <span className="text-slate-700 font-extrabold truncate max-w-[155px]" title={String(v)}>
                              {String(v)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {f.actionable && (
                    <div className="flex justify-end pt-1 border-t border-slate-200/50">
                      <button
                        type="button"
                        onClick={() => onGenerateDraft(f)}
                        disabled={generatingId === f.id}
                        className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-xl px-4 py-2.5 transition-all shadow-sm active:scale-95 focus:outline-none cursor-pointer"
                      >
                        {generatingId === f.id ? 'Generating Draft…' : 'Generate Action Draft →'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CopilotPanel({ open, onClose }) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? Number(stored) : null;
  });
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const [followUps, setFollowUps] = useState([]);
  const [generatingId, setGeneratingId] = useState(null);
  const scrollRef = useRef(null);

  // Real agent names for the live "Consulting: X" indicator below — same
  // /agents/status endpoint CommandCenter.jsx/AiGrowth.jsx use, never a
  // guessed/hardcoded id->label map.
  const [agentsMeta, setAgentsMeta] = useState([]);
  useEffect(() => { api.agentsStatus().then(setAgentsMeta).catch(() => {}); }, []);
  const agentName = (id) => agentsMeta.find((a) => a.id === id)?.name || id;

  // Which agents are currently being consulted for the in-flight question —
  // driven by the same live SSE stream (server/agents/runner.js's real
  // start/done events) that already powers the AI Growth orchestration
  // diagram, not a scripted/simulated timeline. Populated only while a
  // request is outstanding; stays empty for cache-only answers (no agent
  // ever runs), which is honest, not a bug.
  const [activeAgents, setActiveAgents] = useState(new Set());
  const esRef = useRef(null);
  useEffect(() => () => esRef.current?.close(), []); // close if the panel unmounts mid-request

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

    const es = new EventSource('/api/agents/live');
    esRef.current = es;
    es.onmessage = (raw) => {
      let event;
      try { event = JSON.parse(raw.data); } catch { return; }
      setActiveAgents((prev) => {
        const next = new Set(prev);
        if (event.type === 'start') next.add(event.agentId); else next.delete(event.agentId);
        return next;
      });
    };

    try {
      const res = await api.copilot.ask(conversationId, text);
      if (!conversationId) {
        setConversationId(res.conversationId);
        localStorage.setItem(STORAGE_KEY, String(res.conversationId));
      }
      setMessages((m) => [...m, {
        role: 'assistant', content: res.answer, created_at: new Date().toISOString(),
        cited_findings: res.citedFindings || [],
      }]);
      setFollowUps(res.followUps || []);
    } catch (e) {
      setError(e.message || 'Something went wrong — try again.');
      setMessages((m) => m.slice(0, -1));
    } finally {
      setAsking(false);
      es.close();
      esRef.current = null;
      setActiveAgents(new Set());
    }
  };

  // Same generator call Action Center's own "Generate Draft" button makes
  // (api.actionCenter.generate), then reuses the exact ?openDraft= deep
  // link NotificationBell already relies on (ActionCenter.jsx consumes it,
  // lands on the right tab, opens DraftModal) instead of inventing a
  // second way to land on a specific draft.
  const generateFromChat = async (finding) => {
    if (!finding.actionable || generatingId) return;
    setGeneratingId(finding.id);
    setError(null);
    try {
      const { generatorId, params, tag, source } = finding.actionable;
      const draft = await api.actionCenter.generate(generatorId, params, source || 'copilot', finding.id);
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

          {messages.map((m, i) => <Bubble key={i} msg={m} onGenerateDraft={generateFromChat} generatingId={generatingId} />)}
          
          {asking && (
            <div className="flex justify-start gap-3 animate-pulse">
              <span className="w-8 h-8 rounded-2xl bg-white border border-slate-200 grid place-items-center text-slate-450 shrink-0 shadow-sm">
                <Bot size={13} />
              </span>
              <div className="bg-white/80 border border-slate-200/60 rounded-[20px] rounded-tl-none px-4 py-3 flex flex-wrap gap-1.5 items-center shrink-0">
                {activeAgents.size > 0 ? (
                  [...activeAgents].map((id) => (
                    <span key={id} className="text-[10px] font-bold text-indigo-650 whitespace-nowrap">
                      Consulting: {agentName(id)}…
                    </span>
                  ))
                ) : (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '120ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '240ms' }} />
                  </>
                )}
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
