import { useEffect, useState } from 'react';
import {
  Sparkles, Lock, AlertCircle, ArrowRight, LogIn, X,
  FileText, Eye, FileSearch, Users, TrendingUp, Gauge, ShieldCheck,
  Plug, Cpu, ClipboardList, CheckCircle2, ChevronDown,
  Building, Mail, Info, Key, Globe, Laptop,
  Activity, Code2, Database
} from 'lucide-react';
import { api } from '../api.js';
import Logo from '../components/Logo.jsx';

// Same four-color accent language as the showcase above (blue/purple/orange/emerald),
// so this section reads as a continuation of that system rather than a flat list.
// The four nodes orbiting the AI Hub in the "Continuous AI Growth Loop" —
// arranged clockwise from the top (Connect Data) to match reading order.
const LOOP_NODES = [
  { icon: Plug, accent: '#2563eb', title: 'Connect Data', text: 'GSC + GA4, always synced.', metricValue: '2', metricLabel: 'sources live', status: 'Synced' },
  { icon: Cpu, accent: '#8b5cf6', title: 'AI Analysis', text: 'Every signal scanned, continuously.', metricValue: '12', metricLabel: 'agents active', status: 'Analyzing' },
  { icon: Sparkles, accent: '#f97316', title: 'Actions Generated', text: 'Evidence-backed fixes, drafted daily.', metricValue: '9', metricLabel: 'actions ready', status: 'Ready' },
  { icon: CheckCircle2, accent: '#059669', title: 'Review & Approve', text: 'Nothing ships without your click.', metricValue: '100%', metricLabel: 'verified', status: 'Active' },
];

// The "Built for Rigor" Recommendation Inspector: one real recommendation,
// with the four things that prove it isn't a guess arranged around it.
const INSPECTOR_RECOMMENDATION = {
  title: 'Improve FAQ Coverage',
  priority: 'High',
  confidence: 98,
  status: 'Verified',
  agent: 'Content Gap Agent',
};

const INSPECTOR_PANELS = [
  {
    id: 'source', label: 'Source', icon: Database, accent: '#2563eb',
    rows: ['Google Search Console', 'Google Analytics', 'Backlink Database'],
    footer: 'Connected Live',
  },
  {
    id: 'evidence', label: 'Evidence', icon: Eye, accent: '#8b5cf6',
    rows: [
      { k: 'Keyword', v: 'best aluminum windows' },
      { k: 'Position', v: '#11' },
      { k: 'Impressions', v: '8,420' },
      { k: 'CTR', v: '1.2%' },
      { k: 'Historical Trend', v: '+18%' },
    ],
  },
  {
    id: 'formula', label: 'Formula', icon: Gauge, accent: '#f97316',
    rows: ['Ref Domains', 'Backlinks', 'Link Quality', 'Spam Penalty'],
    footer: 'Formula Available',
    cta: 'View Calculation',
  },
];

// One entry per tab in the interactive AI Workforce showcase (hero section).
// `accent` drives every colored element for that tab — badge, active rail
// icon, log cursor, metric, chart — so switching tabs visibly re-themes the
// whole showcase instead of just swapping text.
const SHOWCASE_AGENTS = [
  {
    id: 'query',
    tab: 'Query Intelligence',
    icon: Gauge,
    accent: '#2563eb',
    input: 'Google Search Console',
    processing: 'Compares 90 days of query-level impressions & rankings to isolate real week-over-week movers.',
    output: 'Growing Queries List',
    value: 'Catch winning content before competitors do.',
    metricLabel: 'Queries climbing this week',
    metricValue: '38',
    metricDelta: '+12',
    log: ['Pulling 90-day query history from GSC…', 'Comparing week-over-week impression deltas…', '38 queries gained page-one visibility'],
  },
  {
    id: 'technical',
    tab: 'Technical SEO',
    icon: Code2,
    accent: '#8b5cf6',
    input: 'Core Web Vitals + Index Coverage',
    processing: 'Crawls indexation status, page speed, and broken-link signals across every tracked URL.',
    output: 'Prioritized Fix List',
    value: 'Remove hidden blockers throttling your rankings.',
    metricLabel: 'Issues found this scan',
    metricValue: '7',
    metricDelta: '−3',
    log: ['Checking index coverage for 214 URLs…', 'Auditing Core Web Vitals…', '7 open issues — 3 resolved since last scan'],
  },
  {
    id: 'competitor',
    tab: 'Competitor Intelligence',
    icon: Users,
    accent: '#f97316',
    input: 'SERP + Competitor Domains',
    processing: 'Benchmarks your structure, content, and rankings against real, identified competitors.',
    output: 'Competitive Gap Report',
    value: "Know exactly where you're losing ground, and why.",
    metricLabel: 'Competitors tracked',
    metricValue: '5',
    metricDelta: 'live',
    log: ['Identifying real SERP competitors…', 'Diffing content structure & coverage…', '5 competitors benchmarked — 2 new gaps found'],
  },
  {
    id: 'content',
    tab: 'Content Gap',
    icon: FileSearch,
    accent: '#059669',
    input: 'Your Ranking Pages',
    processing: 'Scores each ranking page for completeness against what actually ranks for the same intent.',
    output: 'Content Gap List',
    value: 'Turn near-miss pages into page-one rankings.',
    metricLabel: 'High-priority gaps',
    metricValue: '4',
    metricDelta: 'new',
    log: ['Scoring 62 ranking pages for completeness…', 'Cross-referencing top-3 competitor coverage…', '4 high-priority content gaps identified'],
  },
  {
    id: 'visibility',
    tab: 'AI Visibility',
    icon: Eye,
    accent: '#2563eb',
    input: 'AI Answer Engines',
    processing: 'Checks schema, FAQ presence, and structural readiness for AI answer engines like ChatGPT.',
    output: 'AI Readiness Score',
    value: 'Be the answer AI recommends, not just the link Google shows.',
    metricLabel: 'AI readiness score',
    metricValue: '91',
    metricDelta: '/100',
    log: ['Auditing schema across 25 URLs…', 'Testing structural readiness for AI crawlers…', 'AI readiness score: 91 / 100'],
  },
  {
    id: 'executive',
    tab: 'Executive Report',
    icon: FileText,
    accent: '#8b5cf6',
    input: "Every Agent's Findings",
    processing: "Synthesizes every specialist agent's output into one prioritized, evidence-backed narrative.",
    output: 'Weekly Growth Briefing',
    value: 'One email tells you exactly what changed, and why.',
    metricLabel: 'Reports compiled',
    metricValue: '6',
    metricDelta: 'agents',
    log: ['Collecting findings from 6 specialist agents…', 'Ranking findings by business impact…', 'Weekly growth briefing compiled'],
  },
];

// The end-to-end storytelling strip beneath the showcase.
const FLOW_STEPS = [
  { icon: Database, label: 'GSC + GA4' },
  { icon: Cpu, label: 'AI Agents Analyze' },
  { icon: Sparkles, label: 'Insights Generated' },
  { icon: ClipboardList, label: 'Recommendations' },
  { icon: FileText, label: 'Reports Created' },
  { icon: TrendingUp, label: 'Business Growth' },
];

export default function Login({ onAuthed }) {
  const [authModal, setAuthModal] = useState(null);

  useEffect(() => {
    if (!authModal) return;
    const onKey = (e) => { if (e.key === 'Escape') setAuthModal(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [authModal]);

  return (
    <div className="min-h-screen relative font-sans overflow-hidden bg-gradient-to-tr from-[#94a3b8] via-[#cbd5e1] to-[#e2e8f0] text-[#1e293b]">

      {/* Modern dotted grid background */}
      <div aria-hidden className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: 'radial-gradient(rgba(15,23,42,0.06) 1.2px, transparent 1.2px)', backgroundSize: '32px 32px' }} />

      {/* Titanium steel soft glowing spotlights */}
      <div aria-hidden className="pointer-events-none absolute top-[-10%] right-[-10%] w-[600px] h-[600px] rounded-full blur-[140px] bg-sky-500/10" />
      <div aria-hidden className="pointer-events-none absolute top-[40%] left-[-20%] w-[700px] h-[700px] rounded-full blur-[150px] bg-slate-500/10" />
      <div aria-hidden className="pointer-events-none absolute bottom-[-10%] right-[10%] w-[600px] h-[600px] rounded-full blur-[130px] bg-amber-500/8" />

      {/* Floating soft light particles */}
      <span aria-hidden className="pointer-events-none absolute top-[15%] left-[20%] w-2 h-2 rounded-full bg-amber-500/60 blur-[1px] animate-pulse" />
      <span aria-hidden className="pointer-events-none absolute top-[30%] right-[15%] w-2.5 h-2.5 rounded-full bg-slate-600/40 blur-[1px] animate-pulse" style={{ animationDelay: '0.5s' }} />
      <span aria-hidden className="pointer-events-none absolute bottom-[30%] left-[12%] w-2 h-2 rounded-full bg-sky-500/50 blur-[2px] animate-pulse" style={{ animationDelay: '1.2s' }} />

      <div className="relative z-10 flex flex-col min-h-screen">
        
        {/* Top Navbar */}
        <header className="w-full px-6 sm:px-12 py-4 border-b border-slate-300/40 bg-white/40 backdrop-blur-md">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-slate-900 p-2.5 rounded-2xl shadow-md border border-slate-850">
                <Logo size={24} color="#ffffff" />
              </div>
              <div className="text-left hidden sm:block">
                <div className="text-xs font-black tracking-widest text-slate-900 uppercase leading-none">Search Analytics</div>
                <div className="text-[9px] text-[#ea580c] font-black tracking-widest uppercase mt-1">Zunkiree Labs</div>
              </div>
              <span className="ml-1 hidden sm:inline-flex items-center gap-1 px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-wider bg-slate-900/10 text-slate-800 border border-slate-900/20">
                <Sparkles size={9} strokeWidth={3} className="text-orange-500" /> AI Agency
              </span>
            </div>

            <div className="flex items-center gap-1.5 sm:gap-3">
              <a
                href="/seo-audit/"
                className="text-xs font-black uppercase tracking-widest text-slate-700 hover:text-slate-950 bg-white/80 hover:bg-white border border-slate-300/80 rounded-xl px-3 sm:px-4 py-2.5 sm:py-3 shadow-sm transition active:scale-95 flex items-center gap-1.5 cursor-pointer"
              >
                Free SEO Audit
              </a>
              <button
                type="button"
                onClick={() => setAuthModal('login')}
                className="text-xs font-black uppercase tracking-widest text-slate-700 hover:text-slate-950 bg-white/80 hover:bg-white border border-slate-300/80 rounded-xl px-3 sm:px-4 py-2.5 sm:py-3 shadow-sm transition active:scale-95 flex items-center gap-1.5 cursor-pointer"
              >
                <LogIn size={13} strokeWidth={2.5} /> Log In
              </button>
              <button
                type="button"
                onClick={() => setAuthModal('request')}
                className="text-xs font-black uppercase tracking-widest text-white rounded-xl px-3 sm:px-4.5 py-2.5 sm:py-3 transition active:scale-95 shadow-md shadow-slate-900/10 hover:shadow-slate-900/25 flex items-center gap-1.5 cursor-pointer"
                style={{ background: 'linear-gradient(135deg,#1e293b,#0f172a)' }}
              >
                <span>Request Access</span>
                <ArrowRight size={13} strokeWidth={2.5} className="hidden sm:inline text-orange-500" />
              </button>
            </div>
          </div>
        </header>

        {/* flex-1 keeps the footer pinned to the bottom of the viewport on tall
            screens/short content — the hero used to carry this, now this does. */}
        <div className="flex-1">
          {/* AI Workforce Showcase — interactive product demo, the page's primary storytelling section */}
          <AIWorkforceShowcase />
        </div>

        {/* Continuous AI Growth Loop — replaces the old four-card "How It Works"
            grid with a circular hub-and-orbit diagram, so the page reads as a
            system that never stops rather than a one-time setup checklist. */}
        <section className="w-full px-6 py-24">
          <div className="max-w-3xl mx-auto text-center space-y-3 mb-4">
            <h2 className="text-2xl sm:text-3xl font-black text-slate-900 uppercase tracking-wider">Continuous AI Growth Loop</h2>
            <p className="text-slate-655 text-sm max-w-lg mx-auto font-black">Not a setup wizard you run once — a system that never stops watching, analyzing, and proposing.</p>
          </div>
          <GrowthLoop />
        </section>


        {/* Built for Rigor — the Recommendation Inspector. Not "how it works"
            (that's the Growth Loop above) but "why should I trust it": one
            real recommendation, with the source, evidence, formula, and
            approval step that back it laid out around it like a schematic. */}
        <section className="w-full px-6 py-24">
          <div className="max-w-3xl mx-auto text-center space-y-3 mb-4">
            <h2 className="text-2xl sm:text-3xl font-black text-slate-900 uppercase tracking-wider">Built for Rigor</h2>
            <p className="text-slate-655 text-sm max-w-lg mx-auto font-black">Every recommendation includes its source, supporting evidence, and documented formula.</p>
          </div>
          <RecommendationInspector />
        </section>

        {/* Bottom Call to Action */}
        <section className="w-full relative px-6 py-24 text-center overflow-hidden">
          <div className="relative max-w-3xl mx-auto space-y-5">
            {/* Soft dual-tone glow, echoing the showcase's per-agent accents */}
            <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 rounded-[44px] bg-gradient-to-tr from-orange-500/10 via-transparent to-indigo-500/10 blur-3xl" />

            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest bg-orange-500/10 text-orange-600 border border-orange-500/20">
              <Sparkles size={9} strokeWidth={3} /> Launch Your Growth Engine
            </span>

            <h2 className="text-3xl sm:text-4xl font-black text-slate-900 uppercase tracking-wider leading-tight">
              Stage your organic search growth today.
            </h2>

            <p className="text-slate-655 text-sm max-w-lg mx-auto font-semibold leading-relaxed">
              All access requests undergo manual verification. Setup your credentials now to instantly login upon approval.
            </p>

            <div className="pt-4">
              <button
                type="button"
                onClick={() => setAuthModal('request')}
                className="inline-flex items-center gap-2.5 text-xs font-black uppercase tracking-widest text-white rounded-xl px-7 py-4.5 transition duration-300 hover:scale-105 active:scale-95 cursor-pointer shadow-lg shadow-slate-950/20 hover:shadow-slate-950/40 hover:shadow-2xl border border-white/10"
                style={{ background: 'linear-gradient(135deg,#1e293b,#0f172a)' }}
              >
                <span>Request Access Portal</span>
                <ArrowRight size={14} strokeWidth={2.5} className="text-orange-500" />
              </button>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="w-full py-8 text-center text-[10px] font-black text-slate-400 uppercase tracking-widest border-t border-slate-900 bg-slate-950">
          &copy; {new Date().getFullYear()} ZUNKIRREE LABS · SEARCH ANALYTICS AI · ALL RIGHTS RESERVED
        </footer>
      </div>

      {authModal && <LoginModal initialMode={authModal} onClose={() => setAuthModal(null)} onAuthed={onAuthed} />}
    </div>
  );
}

/* ───────────────────────── CONTINUOUS AI GROWTH LOOP ─────────────────────────
   A central AI Hub with four workflow nodes orbiting it on a single circular
   track — small glowing particles travel the track on loop, standing in for
   "this never stops." The same circular hub-and-orbit layout renders at every
   width; only the geometry (canvas size, orbit radius, hub/card size) scales
   down for mobile so it stays legible instead of swapping to a different
   layout shape. */

function loopGeometry(size, radius) {
  const center = size / 2;
  const trackPath = `M${center},${center - radius} A${radius},${radius} 0 1,1 ${center - 0.01},${center - radius} Z`;
  return {
    center,
    trackPath,
    positions: [
      { left: center, top: center - radius }, // top — Connect Data
      { left: center + radius, top: center }, // right — AI Analysis
      { left: center, top: center + radius }, // bottom — Actions Generated
      { left: center - radius, top: center }, // left — Review & Approve
    ],
  };
}

const LOOP_DESKTOP = { size: 680, radius: 240, hubSize: 190, cardWidth: 202, ...loopGeometry(680, 240) };
const LOOP_MOBILE = { size: 320, radius: 108, hubSize: 100, cardWidth: 84, compact: true, ...loopGeometry(320, 108) };
const LOOP_PARTICLE_COLORS = ['#2563eb', '#8b5cf6', '#f97316'];

function GrowthLoop() {
  return (
    <>
      <div className="hidden lg:block">
        <OrbitDiagram geo={LOOP_DESKTOP} />
      </div>
      <div className="lg:hidden">
        <OrbitDiagram geo={LOOP_MOBILE} />
      </div>
    </>
  );
}

function OrbitDiagram({ geo }) {
  return (
    <div className="relative mx-auto" style={{ width: geo.size, height: geo.size }}>
      <svg viewBox={`0 0 ${geo.size} ${geo.size}`} className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden>
        <path d={geo.trackPath} fill="none" stroke="#cbd5e1" strokeWidth={geo.compact ? 1 : 1.5} strokeDasharray="1 7" strokeLinecap="round" opacity="0.8" />
        {LOOP_PARTICLE_COLORS.map((color, i) => (
          <circle key={color} r={geo.compact ? 2.5 : 4} fill={color} style={{ filter: `drop-shadow(0 0 5px ${color})` }}>
            <animateMotion dur="9s" repeatCount="indefinite" begin={`${i * (9 / LOOP_PARTICLE_COLORS.length)}s`} path={geo.trackPath} />
          </circle>
        ))}
      </svg>

      <GrowthHub center={geo.center} size={geo.hubSize} />

      {LOOP_NODES.map((node, i) => (
        <div key={node.title} className="absolute" style={{ left: geo.positions[i].left, top: geo.positions[i].top, transform: 'translate(-50%, -50%)' }}>
          <LoopNodeCard node={node} width={geo.cardWidth} compact={geo.compact} />
        </div>
      ))}
    </div>
  );
}

function GrowthHub({ center, size }) {
  const mini = size <= 120;
  return (
    <div className="absolute" style={{ left: center, top: center, transform: 'translate(-50%, -50%)' }}>
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 rounded-full blur-3xl"
        style={{ width: size * 1.5, height: size * 1.5, left: -size * 0.25, top: -size * 0.25, background: 'radial-gradient(circle, rgba(108,99,255,0.18), rgba(249,115,22,0.08) 60%, transparent 75%)' }} />
      <div className={`float-soft bg-white/85 backdrop-blur-xl border border-white/80 shadow-[0_30px_70px_-25px_rgba(15,23,42,0.35)] flex flex-col items-center justify-center gap-1.5 text-center ${mini ? 'rounded-[26px]' : 'rounded-[44px]'}`}
        style={{ width: size, height: size }}>
        <span className={`rounded-2xl grid place-items-center shadow-sm ${mini ? 'w-8 h-8' : 'w-11 h-11'}`}
          style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
          <Cpu size={mini ? 15 : 20} strokeWidth={2.25} className="text-white" />
        </span>
        <div className={`font-black uppercase tracking-widest text-slate-900 mt-1 ${mini ? 'text-[9px]' : 'text-[11px]'}`}>AI Hub</div>
        <div className={`font-bold text-slate-500 leading-tight px-2 ${mini ? 'text-[7.5px]' : 'text-[9.5px]'}`}>12 Specialist Agents</div>
        <span className={`inline-flex items-center gap-1.5 mt-1 font-black uppercase tracking-widest text-emerald-600 ${mini ? 'text-[6.5px]' : 'text-[8px]'}`}>
          <span className="relative flex w-1.5 h-1.5">
            <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
            <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-emerald-500" />
          </span>
          Continuously Monitoring
        </span>
      </div>
    </div>
  );
}

function LoopNodeCard({ node, width, compact = false }) {
  return (
    <div className={`bg-white/85 backdrop-blur-xl border border-white/80 shadow-[0_20px_45px_-25px_rgba(15,23,42,0.35)] text-left transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_25px_55px_-20px_rgba(15,23,42,0.4)] ${compact ? 'rounded-[14px] p-2' : 'rounded-[22px] p-4'}`}
      style={{ width }}>
      <div className={`flex items-center justify-between gap-2 ${compact ? 'mb-1' : 'mb-2.5'}`}>
        <span className={`rounded-xl grid place-items-center shrink-0 ${compact ? 'w-5 h-5' : 'w-9 h-9'}`} style={{ background: `${node.accent}14`, color: node.accent }}>
          <node.icon size={compact ? 10 : 16} strokeWidth={2.25} />
        </span>
        {!compact && (
          <span className="inline-flex items-center gap-1 text-[8px] font-black uppercase tracking-wider shrink-0" style={{ color: node.accent }}>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style={{ background: node.accent }} />
            {node.status}
          </span>
        )}
        {compact && (
          <span className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style={{ background: node.accent }} />
        )}
      </div>
      <h3 className={`font-black text-slate-900 uppercase tracking-wide leading-tight ${compact ? 'text-[7.5px] line-clamp-2' : 'text-[11.5px]'}`}>{node.title}</h3>
      <p className={`text-slate-500 font-bold leading-snug ${compact ? 'text-[6px] line-clamp-1 mt-0.5' : 'text-[10px] leading-relaxed mt-1'}`}>{node.text}</p>
      <div className={`flex items-baseline gap-1.5 border-t border-slate-100 ${compact ? 'mt-1 pt-1' : 'mt-2.5 pt-2.5'}`}>
        <span className={`font-black font-mono ${compact ? 'text-[9px]' : 'text-base'}`} style={{ color: node.accent }}>{node.metricValue}</span>
        <span className={`font-black text-slate-400 uppercase tracking-wide ${compact ? 'text-[5.5px]' : 'text-[9px]'}`}>{node.metricLabel}</span>
      </div>
    </div>
  );
}

/* ───────────────────────── RECOMMENDATION INSPECTOR ─────────────────────────
   "Built for Rigor" as a forensic look at one real recommendation instead of
   a marketing claim list. Deliberately NOT a hub-with-radiating-lines layout
   (that's the Growth Loop's shape, above) — this is one dev-tools-style
   inspector panel: a fixed recommendation summary next to an accordion of
   Source / Evidence / Formula that expands on click, the way you'd actually
   audit a real system rather than admire a diagram of one. */

function RecommendationInspector() {
  const [open, setOpen] = useState('evidence');
  const r = INSPECTOR_RECOMMENDATION;

  return (
    <div className="max-w-4xl mx-auto rounded-[32px] bg-white/85 backdrop-blur-xl border border-white/80 shadow-[0_35px_80px_-30px_rgba(15,23,42,0.3)] overflow-hidden">
      {/* Chrome bar — same "inspecting a real, live thing" cue as the showcase's dashboard stage */}
      <div className="h-11 border-b border-slate-200/70 bg-white/60 px-5 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-400/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/70" />
        </div>
        <span className="hidden sm:inline text-[9.5px] font-mono text-slate-500 font-semibold">recommendation-inspector</span>
        <span className="inline-flex items-center gap-1 text-[8.5px] font-black uppercase tracking-widest text-emerald-600">
          <Activity size={9} strokeWidth={3} /> Live
        </span>
      </div>

      <div className="flex flex-col lg:flex-row">
        {/* The object being inspected — fixed, doesn't change with the accordion.
            Centered on mobile (where this stacks full-width above the accordion,
            and left-aligned text reads sparse/lopsided); left-aligned again once
            it becomes a narrow 300px side rail at lg. */}
        <div className="lg:w-[300px] shrink-0 p-6 border-b lg:border-b-0 lg:border-r border-slate-200/70 text-center lg:text-left">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Recommendation</span>
          <h3 className="text-lg font-black text-slate-900 leading-tight mt-1.5">{r.title}</h3>
          <div className="flex flex-wrap justify-center lg:justify-start gap-1.5 mt-3.5">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-wide bg-rose-500/10 text-rose-600 border border-rose-500/20">
              Priority: {r.priority}
            </span>
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-wide bg-emerald-500/10 text-emerald-700 border border-emerald-500/20">
              <CheckCircle2 size={10} strokeWidth={3} /> {r.status}
            </span>
          </div>

          <div className="py-6">
            <div className="text-4xl font-black font-mono text-slate-900 leading-none">
              {r.confidence}<span className="text-lg">%</span>
            </div>
            <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mt-2">Confidence Score</div>
          </div>

          <div className="flex items-center justify-center lg:justify-start gap-2.5 pt-4 border-t border-slate-100">
            <span className="w-8 h-8 rounded-lg bg-slate-100 grid place-items-center text-slate-500 shrink-0">
              <FileSearch size={14} strokeWidth={2.25} />
            </span>
            <div className="text-[10px] leading-tight text-left">
              <div className="text-slate-400 font-bold">Recommended by</div>
              <div className="font-black text-slate-800 mt-0.5">{r.agent}</div>
            </div>
          </div>
        </div>

        {/* The proof — click a row to expand it */}
        <div className="flex-1 divide-y divide-slate-100">
          {INSPECTOR_PANELS.map((p) => (
            <InspectorAccordionRow key={p.id} panel={p} isOpen={open === p.id} onToggle={() => setOpen((o) => (o === p.id ? null : p.id))} />
          ))}
        </div>
      </div>
    </div>
  );
}

function InspectorAccordionRow({ panel, isOpen, onToggle }) {
  const Icon = panel.icon;
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={isOpen}
        className="w-full flex items-center justify-between gap-3 px-6 py-4 text-left cursor-pointer hover:bg-slate-50/70 transition-colors">
        <span className="flex items-center gap-3 min-w-0">
          <span className="w-8 h-8 rounded-xl grid place-items-center shrink-0" style={{ background: `${panel.accent}14`, color: panel.accent }}>
            <Icon size={15} strokeWidth={2.25} />
          </span>
          <span className="text-[11px] font-black uppercase tracking-widest text-slate-800">{panel.label}</span>
        </span>
        <ChevronDown size={15} className={`text-slate-400 shrink-0 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="px-6 pb-5 sm:pl-[62px] text-left fade-up">
          {panel.id === 'source' && (
            <>
              <ul className="space-y-1.5">
                {panel.rows.map((row) => (
                  <li key={row} className="flex items-center gap-2 text-[11.5px] font-bold text-slate-700">
                    <CheckCircle2 size={12} strokeWidth={2.5} style={{ color: panel.accent }} className="shrink-0" />
                    {row}
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-slate-100 text-[9px] font-black uppercase tracking-wide" style={{ color: panel.accent }}>
                <span className="relative flex w-1.5 h-1.5 shrink-0">
                  <span className="absolute inline-flex w-full h-full rounded-full opacity-75 animate-ping" style={{ background: panel.accent }} />
                  <span className="relative inline-flex w-1.5 h-1.5 rounded-full" style={{ background: panel.accent }} />
                </span>
                {panel.footer}
              </div>
            </>
          )}

          {panel.id === 'evidence' && (
            <dl className="space-y-1.5 max-w-sm">
              {panel.rows.map((row) => (
                <div key={row.k} className="flex items-center justify-between gap-3 text-[11.5px]">
                  <dt className="font-bold text-slate-500">{row.k}</dt>
                  <dd className={`font-black font-mono ${row.v.startsWith('+') ? 'text-emerald-600' : 'text-slate-800'}`}>{row.v}</dd>
                </div>
              ))}
            </dl>
          )}

          {panel.id === 'formula' && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {panel.rows.map((row) => (
                  <span key={row} className="text-[9.5px] font-bold px-2 py-1 rounded-lg" style={{ background: `${panel.accent}12`, color: panel.accent }}>{row}</span>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-slate-100">
                <span className="text-[9px] font-black uppercase tracking-wide text-slate-500">{panel.footer}</span>
                <span aria-hidden className="hidden sm:inline">·</span>
                <button type="button" className="text-[9.5px] font-black uppercase tracking-wide inline-flex items-center gap-1 shrink-0 cursor-pointer" style={{ color: panel.accent }}>
                  {panel.cta} <ArrowRight size={10} strokeWidth={2.5} />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── LOGIN / REGISTER MODAL ───────────────────────── */

function LoginModal({ initialMode = 'login', onClose, onAuthed }) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showForgot, setShowForgot] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Lock background scroll while the modal is open — without this, a form
  // taller than the visible viewport (e.g. keyboard open on mobile) scrolls
  // the page behind the modal instead of the modal content itself. Locks
  // both <html> and <body>: which one is actually the page's scrolling
  // element is browser/doctype-dependent (confirmed elsewhere in this app —
  // Chrome delegates scroll to document.documentElement, not body, so
  // locking body alone did nothing there), so both get the same treatment
  // rather than guessing.
  useEffect(() => {
    const html = document.documentElement;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = document.body.style.overflow;
    html.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.login(email, password);
      onAuthed();
    } catch (e2) {
      setErr('Invalid email or password.');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'request') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" onClick={onClose}>
        <div aria-hidden className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
        <div
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-[460px] max-h-[85vh] rounded-[32px] shadow-2xl relative overflow-hidden backdrop-blur-xl border border-slate-300 bg-slate-100/95 text-slate-800 animate-slide-up flex flex-col"
        >
          {/* aura */}
          <div className="absolute -top-24 -left-24 w-48 h-48 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />

          <button type="button" onClick={onClose} aria-label="Close"
            className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full border border-slate-250 hover:border-slate-350 grid place-items-center text-slate-450 hover:text-slate-850 hover:bg-slate-200/50 transition duration-150 focus:outline-none cursor-pointer">
            <X size={15} strokeWidth={2.25} />
          </button>

          {/* Scrolls internally when content is taller than the viewport,
              instead of the page behind the modal scrolling. */}
          <div className="overflow-y-auto overscroll-contain p-6 sm:p-8">
            <RequestAccessForm onBack={() => setMode('login')} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" onClick={onClose}>
      <div aria-hidden className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />

      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[440px] max-h-[85vh] rounded-[32px] shadow-2xl relative overflow-hidden backdrop-blur-xl border border-slate-300 bg-slate-100/95 text-slate-800 animate-slide-up flex flex-col"
      >
        <div className="absolute -top-24 -left-24 w-48 h-48 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />

        <button type="button" onClick={onClose} aria-label="Close"
          className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full border border-slate-250 hover:border-slate-350 grid place-items-center text-slate-450 hover:text-slate-850 hover:bg-slate-200/50 transition duration-150 focus:outline-none cursor-pointer">
          <X size={15} strokeWidth={2.25} />
        </button>

        {/* Scrolls internally when content is taller than the viewport,
            instead of the page behind the modal scrolling. */}
        <div className="overflow-y-auto overscroll-contain p-6 sm:p-8">
        <div className="relative z-[1] space-y-5">
          <div className="flex flex-col items-center text-center">
            <div className="bg-slate-900 p-2.5 rounded-2xl border border-slate-800 shadow-md">
              <Logo size={28} color="#ffffff" />
            </div>
            <div className="mt-3.5">
              <div className="text-xs font-black text-slate-900 uppercase tracking-widest leading-none">Search Analytics AI</div>
              <div className="text-[9.5px] text-[#ea580c] font-black uppercase tracking-widest mt-1">Enterprise Login</div>
            </div>
          </div>

          <form onSubmit={submit} className="space-y-4 pt-2">
            <div>
              <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-550 mb-1.5">Email Address</label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                  <Mail size={13} />
                </span>
                <input
                  type="email"
                  autoFocus
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full text-base sm:text-xs font-semibold border border-slate-250 rounded-xl pl-10 pr-4 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 transition duration-150 text-slate-800 placeholder:text-slate-400"
                />
              </div>
            </div>
            <div>
              <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-555 mb-1.5">Password</label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                  <Lock size={13} />
                </span>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••••"
                  className="w-full text-base sm:text-xs font-semibold border border-slate-250 rounded-xl pl-10 pr-4 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 transition duration-150 text-slate-800 placeholder:text-slate-400"
                />
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] font-semibold">
              <label className="flex items-center gap-1.5 text-slate-500 cursor-pointer select-none">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}
                  className="w-4 h-4 rounded accent-indigo-500 cursor-pointer" />
                Remember Me
              </label>
              <button type="button" onClick={() => setShowForgot((s) => !s)}
                className="text-indigo-650 hover:text-indigo-800 transition">
                Forgot Password?
              </button>
            </div>
            
            {showForgot && (
              <div className="text-[10px] text-slate-650 bg-white border border-slate-200 rounded-xl px-3 py-2 leading-relaxed flex gap-1.5 shadow-sm">
                <Info size={12} className="text-orange-500 shrink-0 mt-0.5" />
                <span>Contact your Zunkiree Labs account administrator to request a credential reset.</span>
              </div>
            )}

            {err && (
              <div className="bg-rose-50 border border-rose-100 text-rose-700 px-3.5 py-2.5 rounded-xl text-[11px] flex items-center gap-2">
                <AlertCircle size={14} className="shrink-0 text-rose-500" />
                <span>{err}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full text-[10px] font-black uppercase tracking-wider py-3.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md shadow-slate-900/10 disabled:opacity-50 cursor-pointer"
              style={{ background: 'linear-gradient(135deg,#1e293b,#0f172a)' }}
            >
              {busy ? 'Verifying Credentials…' : 'Access Workspace'}
            </button>
          </form>

          <div className="text-center text-[10.5px] font-bold text-slate-500">
            Don't have access?{' '}
            <button type="button" onClick={() => setMode('request')} className="text-indigo-650 hover:text-indigo-800 font-bold cursor-pointer">
              Request Access
            </button>
          </div>

          <div className="pt-4 border-t border-slate-200 flex justify-center gap-4 text-[9px] font-black text-slate-400 uppercase tracking-widest">
            <span className="flex items-center gap-1"><ShieldCheck size={11} className="text-emerald-600" /> Secure Link</span>
            <span>·</span>
            <span className="flex items-center gap-1"><Lock size={11} className="text-emerald-600" /> AES-256</span>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── REQUEST ACCESS FORM ───────────────────────── */

function RequestAccessForm({ onBack }) {
  const [companyName, setCompanyName] = useState('');
  const [websiteDomain, setWebsiteDomain] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (password.length < 8) return setErr('Password must be at least 8 characters.');
    if (password !== confirmPassword) return setErr('Passwords don\'t match.');
    setBusy(true);
    try {
      await api.submitSignupRequest({ companyName, websiteDomain, contactEmail, password, message, honeypot });
      setDone(true);
    } catch (e2) {
      setErr(e2.message || 'Could not submit request.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="relative z-[1] text-center space-y-4 py-4">
        <div className="flex justify-center">
          <div className="bg-slate-900 p-2.5 rounded-2xl border border-slate-800 shadow-md">
            <Logo size={28} color="#ffffff" />
          </div>
        </div>
        <h2 className="text-base font-black text-slate-850 uppercase tracking-wider">Request Submitted</h2>
        <p className="text-xs text-slate-500 leading-relaxed font-bold">
          Your request is in the pending review pipeline. Once approved by Zunkiree staff, you will be able to log in with the credentials you just configured.
        </p>
        <button 
          type="button" 
          onClick={onBack}
          className="text-xs font-black uppercase tracking-wider text-indigo-650 hover:text-indigo-800 cursor-pointer"
        >
          ← Return to Login
        </button>
      </div>
    );
  }

  return (
    <div className="relative z-[1] space-y-4">
      <div className="flex flex-col items-center text-center">
        <div className="bg-slate-900 p-2.5 rounded-2xl border border-slate-800 shadow-md">
          <Logo size={28} color="#ffffff" />
        </div>
        <div className="mt-3.5">
          <h2 className="text-sm font-black text-slate-850 uppercase tracking-widest leading-none">Request Portal Access</h2>
          <p className="text-[10px] text-slate-500 font-bold mt-1.5 leading-relaxed">
            Fill in your company profiles below. Setting your admin credentials now speeds up instant loading upon approval.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-3.5">
        <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
          <label htmlFor="company_url">Company URL</label>
          <input id="company_url" type="text" tabIndex={-1} autoComplete="off"
            value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-500 mb-1">Company Name</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Building size={12} />
              </span>
              <input type="text" required autoFocus value={companyName} onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Acme Corp" className="w-full text-base sm:text-xs font-semibold border border-slate-250 rounded-xl pl-9 pr-3 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-800 placeholder:text-slate-400" />
            </div>
          </div>
          <div>
            <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-505 mb-1">Website</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Globe size={12} />
              </span>
              <input type="text" value={websiteDomain} onChange={(e) => setWebsiteDomain(e.target.value)}
                placeholder="acme.com" className="w-full text-base sm:text-xs font-semibold border border-slate-250 rounded-xl pl-9 pr-3 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-800 placeholder:text-slate-400" />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-505 mb-1">Work Email</label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
              <Mail size={12} />
            </span>
            <input type="email" required autoComplete="username" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
              placeholder="you@acme.com" className="w-full text-base sm:text-xs font-semibold border border-slate-250 rounded-xl pl-9 pr-3 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-800 placeholder:text-slate-400" />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-500 mb-1">Password</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Lock size={12} />
              </span>
              <input type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 chars" className="w-full text-base sm:text-xs font-semibold border border-slate-250 rounded-xl pl-9 pr-3 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-800 placeholder:text-slate-400" minLength={8} />
            </div>
          </div>
          <div>
            <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-500 mb-1">Confirm</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Lock size={12} />
              </span>
              <input type="password" required autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat password" className="w-full text-base sm:text-xs font-semibold border border-slate-250 rounded-xl pl-9 pr-3 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-800 placeholder:text-slate-400" minLength={8} />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-505 mb-1">Brief Description (Optional)</label>
          <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="What domains do you wish to monitor?" className="w-full text-base sm:text-xs font-semibold border border-slate-250 rounded-xl p-3 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-850 placeholder:text-slate-400 resize-none" />
        </div>

        {err && (
          <div className="bg-rose-50 border border-rose-100 text-rose-700 px-3.5 py-2.5 rounded-xl text-[11px] flex items-center gap-2">
            <AlertCircle size={14} className="shrink-0 text-rose-500" />
            <span>{err}</span>
          </div>
        )}

        <button type="submit" disabled={busy}
          className="w-full text-[10px] font-black uppercase tracking-wider py-3.5 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] shadow-md shadow-slate-900/10 disabled:opacity-50 cursor-pointer"
          style={{ background: 'linear-gradient(135deg,#1e293b,#0f172a)' }}
        >
          {busy ? 'Submitting Application…' : 'Submit Access Request'}
        </button>
        <button type="button" onClick={onBack}
          className="w-full text-center text-[10px] font-bold text-slate-500 hover:text-slate-700 uppercase tracking-widest cursor-pointer">
          ← Back to Login
        </button>
      </form>
    </div>
  );
}

/* ───────────────────────── AI WORKFORCE SHOWCASE ─────────────────────────
   The landing page's primary storytelling section: one interactive product
   demo instead of a static dashboard screenshot + a separate redundant grid
   of agent cards. Six tabs, one accent color each — switching tabs re-themes
   the whole panel (rail, log cursor, metric, chart, side-panel timeline) so
   it reads as "the AI is alive," not a re-skinned feature list. */

function AIWorkforceShowcase() {
  const [active, setActive] = useState(0);
  const [logIndex, setLogIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const agent = SHOWCASE_AGENTS[active];

  // Streaming log: reveal one more line every ~1.1s while this tab is active.
  useEffect(() => {
    setLogIndex(0);
    const id = setInterval(() => {
      setLogIndex((i) => (i + 1 < agent.log.length ? i + 1 : i));
    }, 1100);
    return () => clearInterval(id);
  }, [active, agent.log.length]);

  // Auto-advance tabs so the section demonstrates itself without a click —
  // paused while the visitor's cursor is over it.
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setActive((a) => (a + 1) % SHOWCASE_AGENTS.length), 6000);
    return () => clearInterval(id);
  }, [paused]);

  return (
    <section
      className="w-full px-6 pt-10 pb-20 lg:pt-14 lg:pb-24 relative overflow-hidden"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Ambient accent glow — follows the active agent's color */}
      <div aria-hidden className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[460px] rounded-full blur-[160px] transition-[background] duration-700"
        style={{ background: `${agent.accent}14` }} />

      <div className="relative max-w-3xl mx-auto text-center mb-12">
        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest border transition-colors duration-500"
          style={{ background: `${agent.accent}14`, color: agent.accent, borderColor: `${agent.accent}40` }}>
          <Activity size={10} strokeWidth={3} /> Live Product Walkthrough
        </span>
        <h2 className="text-2xl sm:text-3xl lg:text-4xl font-black text-slate-900 uppercase tracking-wider mt-4 leading-tight">
          Watch Your AI Workforce Analyze Your Website
        </h2>
        <p className="text-slate-655 text-sm max-w-xl mx-auto mt-3 font-bold leading-relaxed">
          Six specialist agents, one real workflow. Pick an agent to see exactly what it reads, what it decides, and what lands in your briefing.
        </p>
      </div>

      {/* Tab bar — a fixed 2-column grid on mobile keeps 6 variable-width
          pills in a symmetric 2x3 block instead of flex-wrap's lopsided
          2/1/2/1 breaks; reverts to the free-flowing centered pill bar at sm+. */}
      <div className="relative max-w-4xl mx-auto grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-center mb-8">
        {SHOWCASE_AGENTS.map((a, i) => {
          const isActive = i === active;
          return (
            <button key={a.id} type="button" onClick={() => setActive(i)}
              className={`inline-flex items-center justify-center gap-1.5 text-[10px] sm:text-[10.5px] font-black uppercase tracking-wide rounded-full px-2.5 sm:px-3.5 py-2.5 border transition-all duration-300 cursor-pointer ${
                isActive ? 'scale-[1.03] shadow-md' : 'bg-white/60 border-slate-300/70 text-slate-500 hover:text-slate-800 hover:bg-white'
              }`}
              style={isActive ? { background: `${a.accent}14`, borderColor: `${a.accent}55`, color: a.accent, boxShadow: `0 8px 20px -8px ${a.accent}55` } : undefined}>
              <a.icon size={13} strokeWidth={2.5} className="shrink-0" />
              <span className="truncate">{a.tab}</span>
            </button>
          );
        })}
      </div>

      {/* Main showcase: dashboard stage + explainer side panel */}
      <div className="relative max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5">
        <DashboardStage agent={agent} active={active} logIndex={logIndex} />
        <SidePanel agent={agent} />
      </div>

      {/* Storytelling flow strip */}
      <div className="relative max-w-5xl mx-auto mt-14">
        <FlowStrip accent={agent.accent} />
      </div>
    </section>
  );
}

function DashboardStage({ agent, active, logIndex }) {
  return (
    <div className="rounded-[32px] bg-white/70 backdrop-blur-xl border border-slate-200/80 shadow-[0_30px_70px_-30px_rgba(15,23,42,0.25)] overflow-hidden text-left">
      {/* Browser chrome bar */}
      <div className="h-11 border-b border-slate-200/70 bg-white/60 px-5 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-400/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/70" />
        </div>
        <div className="hidden sm:flex w-1/2 max-w-xs h-6 bg-slate-100 rounded-lg border border-slate-200 items-center justify-center gap-1.5 text-[9.5px] font-mono text-slate-500 font-semibold">
          <Laptop size={10} className="text-slate-400" />
          <span>zunkiree.ai/growth/command-center</span>
        </div>
        <span className="inline-flex items-center gap-1 text-[8.5px] font-black uppercase tracking-widest text-emerald-600">
          <span className="relative flex w-1.5 h-1.5">
            <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
            <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-emerald-500" />
          </span>
          Live
        </span>
      </div>

      <div className="flex">
        {/* Agent rail — every agent visible, only the active one lit up, rest muted */}
        <div className="hidden sm:flex flex-col items-center gap-2 py-6 px-3 border-r border-slate-200/70 bg-slate-50/40">
          {SHOWCASE_AGENTS.map((a, i) => {
            const isActive = i === active;
            return (
              <span key={a.id} title={a.tab}
                className={`w-9 h-9 rounded-xl grid place-items-center border transition-all duration-300 ${isActive ? 'scale-110 shadow-md' : 'opacity-35 grayscale border-transparent'}`}
                style={isActive ? { background: `${a.accent}18`, borderColor: `${a.accent}55`, color: a.accent } : { color: '#94a3b8' }}>
                <a.icon size={15} strokeWidth={2.25} />
              </span>
            );
          })}
        </div>

        {/* Main analysis pane — remounts (key) on tab change for a clean fade-up */}
        <div key={agent.id} className="flex-1 min-w-0 p-7 sm:p-9 fade-up">
          <div className="flex items-center justify-between mb-6 gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-9 h-9 rounded-xl grid place-items-center border shrink-0"
                style={{ background: `${agent.accent}14`, borderColor: `${agent.accent}40`, color: agent.accent }}>
                <agent.icon size={16} strokeWidth={2.25} />
              </span>
              <div className="min-w-0">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-800 truncate">{agent.tab}</h3>
                <p className="text-[9.5px] text-slate-500 font-bold mt-0.5">Specialist agent · analyzing in real time</p>
              </div>
            </div>
            <span className="hidden sm:inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full border shrink-0"
              style={{ background: `${agent.accent}12`, borderColor: `${agent.accent}35`, color: agent.accent }}>
              <Activity size={9} strokeWidth={3} /> Analyzing
            </span>
          </div>

          {/* Streaming log — types itself out line by line */}
          <div className="rounded-2xl bg-slate-950 border border-slate-800 p-5 font-mono text-[10.5px] leading-relaxed space-y-2.5 min-h-[136px] flex flex-col justify-center">
            {agent.log.slice(0, logIndex + 1).map((line, i) => {
              const isCurrent = i === logIndex;
              const isDone = i === agent.log.length - 1 && isCurrent;
              return (
                <div key={i} className={`flex items-center gap-2 ${isCurrent ? 'text-slate-100' : 'text-slate-500'}`}>
                  <span style={{ color: agent.accent }}>{isDone ? '✓' : '❯'}</span>
                  <span className="truncate">{line}</span>
                  {isCurrent && !isDone && <span className="w-1.5 h-3 shrink-0 animate-pulse" style={{ background: agent.accent }} />}
                </div>
              );
            })}
          </div>

          {/* Metric + chart row */}
          <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 mt-6 items-stretch">
            <div className="rounded-2xl bg-white border border-slate-200/80 shadow-sm p-5 sm:min-w-[170px] flex flex-col justify-center">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-450">{agent.metricLabel}</div>
              <div className="flex items-baseline gap-1.5 mt-2.5">
                <span className="text-3xl font-black font-mono" style={{ color: agent.accent }}>{agent.metricValue}</span>
                <span className="text-[10px] font-black text-slate-400">{agent.metricDelta}</span>
              </div>
            </div>
            <div className="rounded-2xl bg-white border border-slate-200/80 shadow-sm p-5 flex items-end">
              <ShowcaseChart accent={agent.accent} seed={active} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SidePanel({ agent }) {
  const stages = [
    { label: 'Input', text: agent.input },
    { label: 'AI Analysis', text: agent.processing },
    { label: 'Output', text: agent.output },
    { label: 'Business Value', text: agent.value },
  ];
  return (
    <div key={agent.id} className="rounded-[28px] bg-white/70 backdrop-blur-xl border border-slate-200/80 shadow-[0_20px_50px_-25px_rgba(15,23,42,0.2)] p-6 text-left fade-up">
      <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-450 mb-5">How this agent works</h4>
      <div className="relative pl-7">
        <div aria-hidden className="absolute left-[11px] top-1.5 bottom-1.5 w-px bg-slate-200" />
        {stages.map((s, i) => (
          <div key={s.label} className="relative pb-6 last:pb-0">
            <span className="absolute -left-7 top-0.5 w-[22px] h-[22px] rounded-full border-2 bg-white grid place-items-center text-[9px] font-black shrink-0"
              style={{ borderColor: `${agent.accent}70`, color: agent.accent }}>
              {i + 1}
            </span>
            <div className="text-[9px] font-black uppercase tracking-widest" style={{ color: agent.accent }}>{s.label}</div>
            <p className="text-[11.5px] text-slate-700 font-bold leading-relaxed mt-1">{s.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowStrip({ accent }) {
  return (
    // Single row at every width (mirrors desktop) instead of wrapping into
    // two rows on mobile — icons/text/columns just shrink to fit. justify-start
    // (not center) with overflow-x-auto: centering an overflowing flex line
    // clips the start permanently (LTR can't scroll to negative scrollLeft),
    // which was chewing the leading "G" off "GSC + GA4".
    <div className="flex flex-nowrap items-start justify-start sm:justify-center gap-x-0.5 sm:gap-x-1 overflow-x-auto sm:overflow-visible">
      {FLOW_STEPS.map((s, i) => (
        <div key={s.label} className="flex items-start shrink-0">
          <div className="flex flex-col items-center gap-1 sm:gap-1.5 px-0.5 sm:px-2 w-[46px] sm:w-[84px]">
            <span className="w-6 h-6 sm:w-9 sm:h-9 rounded-full bg-white border border-slate-200/80 shadow-sm grid place-items-center text-slate-500 shrink-0">
              <s.icon size={11} strokeWidth={2.25} className="sm:hidden" />
              <s.icon size={14} strokeWidth={2.25} className="hidden sm:block" />
            </span>
            {/* break-words: "RECOMMENDATIONS" is a single unbreakable word
                wider than the mobile column, and min-content forces the box
                wider than its declared width without it — bleeding into the
                next column. */}
            <span className="w-full text-[6.5px] sm:text-[8px] font-black uppercase tracking-wider text-slate-500 text-center leading-tight break-words">{s.label}</span>
          </div>
          {i < FLOW_STEPS.length - 1 && (
            <svg viewBox="0 0 24 10" height="10" className="shrink-0 mt-2.5 sm:mt-4 w-2 sm:w-6" preserveAspectRatio="none">
              <line x1="0" y1="5" x2="24" y2="5" stroke={accent} strokeWidth="1.5" strokeDasharray="4 4" className="dash-flow" />
            </svg>
          )}
        </div>
      ))}
    </div>
  );
}

// Deterministic pseudo-variation per agent (via `seed`) so the chart doesn't
// look identical on every tab, without needing real data on a logged-out page.
function ShowcaseChart({ accent, seed }) {
  const base = [45, 38, 41, 28, 32, 20, 26, 12, 20, 5, 12];
  const points = base.map((v, i) => Math.max(4, v + (((seed + i) * 13) % 9) - 4));
  const line = points.map((v, i) => `${i * 28},${v}`).join(' ');
  const gradientId = `showcaseFill-${seed}`;
  return (
    <svg viewBox="0 0 280 60" className="w-full h-24" preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={accent} stopOpacity="0.18" />
          <stop offset="1" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M0,${points[0]} L${line} L280,60 L0,60 Z`} fill={`url(#${gradientId})`} />
      <polyline points={line} fill="none" stroke={accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
