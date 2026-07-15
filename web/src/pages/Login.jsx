import { useEffect, useState } from 'react';
import {
  Sparkles, Check, Lock, AlertCircle, ArrowRight, LogIn, X,
  FileText, Eye, FileSearch, Users, TrendingUp, Gauge, ShieldCheck,
  Plug, Cpu, ClipboardList, CheckCircle2, Globe2, Smartphone, Code2, Link2, MessageSquare, EyeOff,
  Building, Mail, Info, Key, Globe, Layout, Laptop
} from 'lucide-react';
import { api } from '../api.js';
import Logo from '../components/Logo.jsx';

const PILLS = ['AI Agents', 'Google Search Console', 'Google Analytics 4', 'Automated Reports'];

const STEPS = [
  { icon: Plug, title: 'Connect your real data', text: 'Grant access to your Google Search Console and Analytics properties — the same data you already have, nothing new to set up.' },
  { icon: Cpu, title: 'AI agents analyze continuously', text: 'Specialist agents run daily and weekly, each looking at one real slice of your search performance — never a single generic model guessing at everything.' },
  { icon: ClipboardList, title: 'Get a prioritized, evidence-backed briefing', text: 'Every finding cites the real numbers behind it — an impression count, a ranking delta, a real page — never a vague "you should improve SEO."' },
  { icon: CheckCircle2, title: 'Review and approve every fix', text: 'Agents draft the fix — a title, an FAQ, a schema block — you approve it. Nothing publishes or changes your site without you clicking approve.' },
];

const AGENT_GRID = [
  { icon: Gauge, name: 'Query Intelligence', text: 'Finds real search-query gainers and droppers week over week.' },
  { icon: TrendingUp, name: 'Opportunity Agent', text: 'Surfaces striking-distance keywords close to page one.' },
  { icon: Globe2, name: 'Country Intelligence', text: 'Flags growing and declining markets from real geography data.' },
  { icon: Smartphone, name: 'Device Intelligence', text: 'Catches real device-split performance problems.' },
  { icon: Eye, name: 'AI Visibility', text: 'Checks schema, FAQ, and structural readiness for AI answer engines.' },
  { icon: FileSearch, name: 'Content Gap', text: 'Scores your ranking pages for real completeness gaps.' },
  { icon: Users, name: 'Competitor Intelligence', text: 'Identifies real competitors and compares your structure against theirs.' },
  { icon: Code2, name: 'Technical SEO', text: 'Real Google index status, Core Web Vitals, and broken-link checks.' },
  { icon: Link2, name: 'Authority Score', text: 'A transparent, real backlink-based authority score — never a black-box number.' },
  { icon: MessageSquare, name: 'AI Recommendation', text: 'Tests whether ChatGPT actually recommends you for real buyer questions.' },
  { icon: FileText, name: 'Executive Report', text: 'Synthesizes every agent into one weekly growth narrative.' },
];

const HONESTY_POINTS = [
  { icon: ShieldCheck, title: 'Never a fabricated metric', text: 'If we don\'t have a real data source for something, we say so — "insufficient data," not a made-up number.' },
  { icon: EyeOff, title: 'No black-box scores', text: 'Every score — Authority, Health, AI Visibility — is a documented formula over real data, and every input is shown.' },
  { icon: FileText, title: 'Evidence on every finding', text: 'A recommendation always cites the real number behind it — no generic advice with nothing backing it up.' },
];

const AGENTS = [
  { icon: FileText, name: 'Executive Summary Agent', status: 'completed', text: 'Synthesizes every specialist agent into one weekly growth summary.' },
  { icon: Eye, name: 'AI Visibility Agent', status: 'running', progress: 72, text: 'Checks schema, FAQ presence, and structural signals that determine AI-answer-engine readiness.' },
  { icon: FileSearch, name: 'Content Gap Agent', status: 'completed', text: 'Scores ranking pages for content completeness gaps.' },
  { icon: Users, name: 'Competitor Intelligence', status: 'running', text: 'Identifies real competitors and compares content, SEO structure, and positioning.' },
  { icon: TrendingUp, name: 'Ranking Opportunity Agent', status: 'running', text: 'Finds striking-distance keywords close to page one.' },
  { icon: Gauge, name: 'Query Intelligence Agent', status: 'completed', text: 'Analyzed search queries for gainers and droppers.' },
];

const METRICS = [
  { label: 'Organic Growth Forecast', value: '+18%', color: '#10b981' },
  { label: 'Visibility Score', value: '91/100', color: '#6C63FF' },
  { label: 'Ranking Opportunities', value: '27', color: '#f97316' },
  { label: 'AI Insights Generated', value: '146', color: '#9c27b0' },
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
        <header className="w-full flex items-center justify-between px-6 sm:px-12 py-6 lg:py-8 border-b border-slate-300/40 bg-white/40 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="bg-slate-900 p-2.5 rounded-2xl shadow-md border border-slate-850">
              <Logo size={24} color="#ffffff" />
            </div>
            <div className="text-left hidden sm:block">
              <div className="text-xs font-black tracking-widest text-slate-900 uppercase leading-none">Search Analytics</div>
              <div className="text-[9px] text-[#ea580c] font-black tracking-widest uppercase mt-1">Zunkiree Labs</div>
            </div>
            <span className="ml-1 inline-flex items-center gap-1 px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-wider bg-slate-900/10 text-slate-800 border border-slate-900/20">
              <Sparkles size={9} strokeWidth={3} className="text-orange-500" /> AI Agency
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button 
              type="button" 
              onClick={() => setAuthModal('login')}
              className="text-xs font-black uppercase tracking-widest text-slate-700 hover:text-slate-950 bg-white/80 hover:bg-white border border-slate-300/80 rounded-xl px-4 py-2.5 shadow-sm transition active:scale-95 flex items-center gap-1.5 cursor-pointer"
            >
              <LogIn size={13} strokeWidth={2.5} /> Log In
            </button>
            <button 
              type="button" 
              onClick={() => setAuthModal('request')}
              className="text-xs font-black uppercase tracking-widest text-white rounded-xl px-4.5 py-2.5 transition active:scale-95 shadow-md shadow-slate-900/10 hover:shadow-slate-900/25 flex items-center gap-1.5 cursor-pointer"
              style={{ background: 'linear-gradient(135deg,#1e293b,#0f172a)' }}
            >
              <span>Request Access</span>
              <ArrowRight size={13} strokeWidth={2.5} className="text-orange-500" />
            </button>
          </div>
        </header>

        {/* Hero Section */}
        <div className="flex-1 flex flex-col items-center text-center px-6 pb-20 pt-14 lg:pt-20 w-full max-w-6xl mx-auto">
          <h1 className="text-4xl sm:text-5xl lg:text-[3.6rem] font-black tracking-tight text-slate-900 leading-[1.08] mb-6 max-w-4xl">
            Autonomous Search Insights for{' '}
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-slate-950 via-[#ea580c] to-indigo-900">
              Organic Growth Teams.
            </span>
          </h1>
          
          <p className="text-slate-750 text-sm sm:text-base leading-relaxed max-w-2xl mb-10 font-bold">
            Deploy an autonomous workforce of 11 dedicated AI specialist agents to analyze Search Console data, audit indexing issues, and draft complete code solutions in your Action Center.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-2 mb-12">
            {PILLS.map((p) => (
              <span key={p} className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-slate-800 bg-white/70 border border-slate-300 shadow-sm rounded-full px-3.5 py-2">
                <Check size={12} strokeWidth={3} className="text-orange-600" /> {p}
              </span>
            ))}
          </div>

          {/* SaaS Workspace Preview (High-fidelity light browser mockup) */}
          <div className="w-full relative group">
            {/* Ambient backlight glow on hover */}
            <div className="absolute inset-0 -z-10 rounded-[36px] bg-gradient-to-tr from-slate-900/20 to-amber-500/10 opacity-60 blur-3xl transition duration-500 group-hover:opacity-80" />
            <WorkspacePreview />
          </div>
        </div>

        {/* How It Works Section */}
        <section className="w-full px-6 py-24 border-t border-slate-300/40 bg-white/30">
          <div className="max-w-5xl mx-auto text-center space-y-3">
            <h2 className="text-2xl sm:text-3xl font-black text-slate-900 uppercase tracking-wider">How It Works</h2>
            <p className="text-slate-655 text-sm max-w-lg mx-auto pb-10 font-black">Continuous data pipelines and human-in-the-loop approvals.</p>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 text-left">
              {STEPS.map((s, i) => (
                <div key={s.title} className="relative bg-white/80 border border-white rounded-2xl p-5 hover:border-slate-350 transition duration-150 flex flex-col justify-between min-h-[190px] shadow-sm">
                  <span className="absolute -top-3.5 -left-2.5 w-7 h-7 rounded-full bg-gradient-to-br from-slate-900 to-slate-850 text-white text-xs font-black grid place-items-center shadow-md">{i + 1}</span>
                  <div>
                    <s.icon size={20} strokeWidth={2.25} className="text-orange-600 mb-4" />
                    <h3 className="text-sm font-black text-slate-900 leading-tight mb-2">{s.title}</h3>
                  </div>
                  <p className="text-[11px] text-slate-655 leading-relaxed font-bold">{s.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 11 Specialist Agents Section */}
        <section className="w-full px-6 py-24 border-t border-slate-300 bg-white/50">
          <div className="max-w-5xl mx-auto text-center space-y-3">
            <h2 className="text-2xl sm:text-3xl font-black text-slate-900 uppercase tracking-wider">The Agent Taskforce</h2>
            <p className="text-slate-655 text-sm max-w-lg mx-auto pb-10 font-black">11 automated specialist workers, never a single generic model.</p>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 text-left">
              {AGENT_GRID.map((a) => (
                <div key={a.name} className="flex items-start gap-4 bg-white/60 border border-white/80 rounded-2xl p-4.5 hover:border-slate-300/80 transition duration-150 shadow-sm">
                  <span className="w-9 h-9 rounded-xl bg-white border border-slate-200 grid place-items-center shrink-0 text-orange-600 shadow-sm">
                    <a.icon size={16} strokeWidth={2.25} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest">{a.name}</h3>
                    <p className="text-[11.5px] text-slate-600 leading-relaxed mt-1.5 font-bold">{a.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Open Architecture Section */}
        <section className="w-full px-6 py-24 border-t border-slate-300 bg-white/30">
          <div className="max-w-4xl mx-auto text-center space-y-3">
            <h2 className="text-2xl sm:text-3xl font-black text-slate-900 uppercase tracking-wider">Built for Rigor</h2>
            <p className="text-slate-655 text-sm max-w-lg mx-auto pb-10 font-black">Fully transparent datasets, clear scoring definitions, and zero black-boxes.</p>
            
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-left">
              {HONESTY_POINTS.map((h) => (
                <div key={h.title} className="bg-white/80 border border-white/90 rounded-2xl p-5 hover:border-slate-350 transition shadow-sm">
                  <h.icon size={22} strokeWidth={2} className="text-emerald-600 mb-4" />
                  <h3 className="text-sm font-black text-slate-900 mb-2 leading-snug">{h.title}</h3>
                  <p className="text-[11px] text-slate-655 leading-relaxed font-bold">{h.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Bottom Call to Action */}
        <section className="w-full px-6 py-24 border-t border-slate-300 text-center bg-slate-900/[0.01]">
          <h2 className="text-2xl sm:text-3xl font-black text-slate-900 uppercase tracking-wider mb-4">Stage your organic search growth today.</h2>
          <p className="text-slate-705 text-sm max-w-md mx-auto mb-8 font-bold">All access requests undergo manual verification. Setup your credentials now to instantly login upon approval.</p>
          <button 
            type="button" 
            onClick={() => setAuthModal('request')}
            className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-widest text-white rounded-xl px-6 py-3.5 shadow-md shadow-slate-950/10 hover:shadow-slate-950/25 transition active:scale-95 cursor-pointer"
            style={{ background: 'linear-gradient(135deg,#1e293b,#0f172a)' }}
          >
            <span>Request Access</span>
            <ArrowRight size={14} strokeWidth={2.5} className="text-orange-500" />
          </button>
        </section>

        {/* Footer */}
        <footer className="w-full py-8 text-center text-[10px] font-black text-slate-500 uppercase tracking-widest border-t border-slate-300/40">
          &copy; {new Date().getFullYear()} ZUNKIRREE LABS · SEARCH ANALYTICS AI · ALL RIGHTS RESERVED
        </footer>
      </div>

      {authModal && <LoginModal initialMode={authModal} onClose={() => setAuthModal(null)} onAuthed={onAuthed} />}
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
          className="w-full max-w-[460px] rounded-[32px] p-6 sm:p-8 shadow-2xl relative overflow-hidden backdrop-blur-xl border border-slate-300 bg-slate-100/95 text-slate-800 animate-slide-up"
        >
          {/* aura */}
          <div className="absolute -top-24 -left-24 w-48 h-48 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />
          
          <button type="button" onClick={onClose} aria-label="Close"
            className="absolute top-4 right-4 z-10 w-8 h-8 rounded-full border border-slate-250 hover:border-slate-350 grid place-items-center text-slate-450 hover:text-slate-850 hover:bg-slate-200/50 transition duration-150 focus:outline-none cursor-pointer">
            <X size={15} strokeWidth={2.25} />
          </button>
          
          <RequestAccessForm onBack={() => setMode('login')} />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" onClick={onClose}>
      <div aria-hidden className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />

      <div 
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[440px] rounded-[32px] p-6 sm:p-8 shadow-2xl relative overflow-hidden backdrop-blur-xl border border-slate-300 bg-slate-100/95 text-slate-800 animate-slide-up"
      >
        <div className="absolute -top-24 -left-24 w-48 h-48 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />

        <button type="button" onClick={onClose} aria-label="Close"
          className="absolute top-4 right-4 z-10 w-8 h-8 rounded-full border border-slate-250 hover:border-slate-350 grid place-items-center text-slate-450 hover:text-slate-850 hover:bg-slate-200/50 transition duration-150 focus:outline-none cursor-pointer">
          <X size={15} strokeWidth={2.25} />
        </button>

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
                  className="w-full text-xs font-semibold border border-slate-250 rounded-xl pl-10 pr-4 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 transition duration-150 text-slate-800 placeholder:text-slate-400"
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
                  className="w-full text-xs font-semibold border border-slate-250 rounded-xl pl-10 pr-4 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 transition duration-150 text-slate-800 placeholder:text-slate-400"
                />
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] font-semibold">
              <label className="flex items-center gap-1.5 text-slate-500 cursor-pointer select-none">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-indigo-500 cursor-pointer" />
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

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-500 mb-1">Company Name</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Building size={12} />
              </span>
              <input type="text" required autoFocus value={companyName} onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Acme Corp" className="w-full text-xs font-semibold border border-slate-250 rounded-xl pl-9 pr-3 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-800 placeholder:text-slate-400" />
            </div>
          </div>
          <div>
            <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-505 mb-1">Website</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Globe size={12} />
              </span>
              <input type="text" value={websiteDomain} onChange={(e) => setWebsiteDomain(e.target.value)}
                placeholder="acme.com" className="w-full text-xs font-semibold border border-slate-250 rounded-xl pl-9 pr-3 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-800 placeholder:text-slate-400" />
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
              placeholder="you@acme.com" className="w-full text-xs font-semibold border border-slate-250 rounded-xl pl-9 pr-3 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-800 placeholder:text-slate-400" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-500 mb-1">Password</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Lock size={12} />
              </span>
              <input type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 chars" className="w-full text-xs font-semibold border border-slate-250 rounded-xl pl-9 pr-3 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-800 placeholder:text-slate-400" minLength={8} />
            </div>
          </div>
          <div>
            <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-500 mb-1">Confirm</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Lock size={12} />
              </span>
              <input type="password" required autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat password" className="w-full text-xs font-semibold border border-slate-250 rounded-xl pl-9 pr-3 py-2.5 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-800 placeholder:text-slate-400" minLength={8} />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-[9.5px] font-black uppercase tracking-widest text-slate-505 mb-1">Brief Description (Optional)</label>
          <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="What domains do you wish to monitor?" className="w-full text-xs font-semibold border border-slate-250 rounded-xl p-3 bg-white/80 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/10 focus:border-orange-500 text-slate-850 placeholder:text-slate-400 resize-none" />
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

/* ───────────────────────── LIVE AI WORKSPACE PREVIEW ───────────────────────── */

function WorkspacePreview() {
  return (
    <div className="w-full rounded-[36px] bg-slate-950 border border-slate-800 shadow-[0_32px_80px_-20px_rgba(0,0,0,0.8),inset_0_1px_1px_rgba(255,255,255,0.08)] text-left relative overflow-hidden">
      
      {/* Browser chrome header bar */}
      <div className="h-11 border-b border-slate-900 bg-slate-950 px-5 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-rose-500/80" />
          <span className="w-3 h-3 rounded-full bg-amber-500/80" />
          <span className="w-3 h-3 rounded-full bg-emerald-500/80" />
        </div>
        <div className="w-1/2 max-w-sm h-6 bg-slate-900 rounded-lg border border-slate-850 flex items-center justify-center gap-1.5 text-[10px] font-mono text-slate-500 font-semibold select-all">
          <Laptop size={10} className="text-slate-655" />
          <span>zunkiree.ai/Nepal-Travel/growth</span>
        </div>
        <div className="flex items-center gap-2 text-slate-600">
          <Layout size={13} />
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Workspace Active Agent Header */}
        <div className="flex items-center justify-between border-b border-slate-900 pb-4.5">
          <div className="flex items-center gap-2.5">
            <span className="relative flex w-2.5 h-2.5">
              <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-450 opacity-75 animate-ping" />
              <span className="relative inline-flex w-2.5 h-2.5 rounded-full bg-emerald-550" />
            </span>
            <div>
              <h3 className="text-xs font-black uppercase tracking-widest text-slate-350">Live Agent Taskforce Activity</h3>
              <p className="text-[9.5px] text-slate-500 font-bold mt-0.5">Specialist workers analyzing index channels in real time</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-2.5 py-1">
            <Sparkles size={9} strokeWidth={3} className="text-orange-500" /> Active Audits
          </span>
        </div>

        {/* 2-Column Grid for Agents */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-1 bg-slate-900/50 rounded-2xl border border-slate-850 p-4">
          {AGENTS.map((a) => <AgentRow key={a.name} {...a} />)}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-stretch pt-2">
          {/* Left: Metrics summary */}
          <div className="md:col-span-6 grid grid-cols-2 gap-3.5">
            {METRICS.map((m) => <MetricTile key={m.label} {...m} />)}
          </div>
          
          {/* Right: organic trend */}
          <div className="md:col-span-6 bg-slate-900/60 border border-slate-850 rounded-2xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-[9.5px] font-black uppercase tracking-widest text-slate-400">Search Visibility Forecast</span>
                <p className="text-[9px] text-slate-550 font-bold mt-0.5">Staged query opportunities impact estimate</p>
              </div>
              <span className="text-[10px] text-emerald-450 font-black uppercase tracking-wider bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full shadow-sm">+18% ▲</span>
            </div>
            <div className="w-full flex-1 flex items-end">
              <PreviewChart />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentRow({ icon: Icon, name, status, progress, text }) {
  const running = status === 'running';
  return (
    <div className="flex items-start gap-3 rounded-2xl px-3 py-3 hover:bg-slate-900/60 border border-transparent hover:border-slate-850 transition duration-150">
      <span className="relative flex w-7.5 h-7.5 rounded-xl items-center justify-center shrink-0 mt-0.5 border border-slate-800 bg-slate-900 shadow-sm"
        style={{ 
          color: running ? '#818cf8' : '#10b981'
        }}>
        <Icon size={13} strokeWidth={2.25} />
        {running && (
          <span className="absolute -top-0.5 -right-0.5 flex w-2 h-2">
            <span className="absolute inline-flex w-full h-full rounded-full bg-indigo-400 opacity-75 animate-ping" />
            <span className="relative inline-flex w-2 h-2 rounded-full bg-indigo-400" />
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2 leading-none">
          <span className="text-[11.5px] font-black text-slate-200 truncate">{name}</span>
          <span className={`text-[8.5px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full shrink-0 border bg-slate-950 ${
            running 
              ? 'text-indigo-400 border-indigo-500/20' 
              : 'text-emerald-400 border-emerald-500/20'
          }`}>
            {running ? 'Audit running' : 'Analysis ok'}
          </span>
        </div>
        <p className="text-[10px] font-semibold text-slate-400 leading-relaxed mt-1.5">{text}</p>
        
        {running && (
          <div className="mt-2 h-1 rounded-full bg-slate-950 overflow-hidden relative border border-slate-950">
            {progress != null ? (
              <div className="h-full rounded-full" style={{ width: `${progress}%`, background: 'linear-gradient(90deg,#6C63FF,#8b5cf6)' }} />
            ) : (
              <div className="absolute inset-y-0 left-0 w-1/3 rounded-full shimmer-sweep animate-pulse"
                style={{ background: 'linear-gradient(90deg,transparent,#8b5cf6,transparent)' }} />
            )}
          </div>
        )}
      </div>
      {progress != null && <span className="text-[9.5px] font-black font-mono text-indigo-400 shrink-0 mt-0.5 ml-1">{progress}%</span>}
    </div>
  );
}

function MetricTile({ label, value, color }) {
  return (
    <div className="bg-slate-900/70 border border-slate-850 rounded-2xl p-4 flex flex-col justify-between shadow-sm">
      <div className="text-[9px] font-black uppercase tracking-widest text-slate-450 leading-none">{label}</div>
      <div className="text-xl font-black mt-3 font-mono leading-none" style={{ color }}>{value}</div>
    </div>
  );
}

function PreviewChart() {
  return (
    <svg viewBox="0 0 280 60" className="w-full h-14" preserveAspectRatio="none">
      <defs>
        <linearGradient id="loginPreviewFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6C63FF" stopOpacity="0.15" />
          <stop offset="1" stopColor="#6C63FF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0,45 28,38 56,41 84,28 112,32 140,20 168,26 196,12 224,20 252,5 280,12 280,60 0,60 Z" fill="url(#loginPreviewFill)" />
      <polyline points="0,45 28,38 56,41 84,28 112,32 140,20 168,26 196,12 224,20 252,5 280,12"
        fill="none" stroke="#6C63FF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
