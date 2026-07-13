import { useEffect, useState } from 'react';
import {
  Sparkles, Check, Lock, AlertCircle, ArrowRight, LogIn, X,
  FileText, Eye, FileSearch, Users, TrendingUp, Gauge, ShieldCheck,
} from 'lucide-react';
import { api } from '../api.js';
import Logo from '../components/Logo.jsx';

const PILLS = ['AI Agents', 'Google Search Console', 'Google Analytics 4', 'Automated Reports'];

const AGENTS = [
  { icon: FileText, name: 'Executive Summary Agent', status: 'completed', text: 'Generated weekly business summary.' },
  { icon: Eye, name: 'AI Visibility Agent', status: 'running', progress: 72, text: 'Analyzing AI Search visibility across ChatGPT, Gemini and Google AI Overview.' },
  { icon: FileSearch, name: 'Content Gap Agent', status: 'completed', text: '12 missing content opportunities discovered.' },
  { icon: Users, name: 'Competitor Intelligence', status: 'completed', text: '3 competitors gained visibility this week.' },
  { icon: TrendingUp, name: 'Ranking Opportunity Agent', status: 'running', text: 'Found 27 keywords that can reach page one.' },
  { icon: Gauge, name: 'Technical SEO Agent', status: 'completed', text: 'Core Web Vitals passed.' },
];

const METRICS = [
  { label: 'Organic Growth Forecast', value: '+18%', color: '#34d399' },
  { label: 'Visibility Score', value: '91/100', color: '#818cf8' },
  { label: 'Ranking Opportunities', value: '27', color: '#38bdf8' },
  { label: 'AI Insights Generated', value: '146', color: '#c084fc' },
];

export default function Login({ onAuthed }) {
  const [showLogin, setShowLogin] = useState(false);

  // Close the login modal on Escape.
  useEffect(() => {
    if (!showLogin) return;
    const onKey = (e) => { if (e.key === 'Escape') setShowLogin(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showLogin]);

  return (
    <div className="min-h-screen relative font-sans overflow-hidden"
      style={{ background: 'linear-gradient(160deg, #0B1020 0%, #101A3A 55%, #0B1020 100%)' }}>

      {/* faint dotted grid */}
      <div aria-hidden className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px)', backgroundSize: '26px 26px' }} />

      {/* ambient glows */}
      <div aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[760px] h-[760px] rounded-full blur-[140px] bg-indigo-500/20" />
      <div aria-hidden className="pointer-events-none absolute -top-32 -left-24 w-[420px] h-[420px] rounded-full blur-[120px] bg-purple-500/10" />
      <div aria-hidden className="pointer-events-none absolute -bottom-24 -right-24 w-[420px] h-[420px] rounded-full blur-[120px] bg-sky-500/10" />

      {/* floating glow particles */}
      <span aria-hidden className="pointer-events-none absolute top-[18%] left-[14%] w-2 h-2 rounded-full bg-indigo-400/70 blur-[1px] animate-pulse" />
      <span aria-hidden className="pointer-events-none absolute top-[26%] right-[12%] w-1.5 h-1.5 rounded-full bg-purple-400/70 blur-[1px] animate-pulse" style={{ animationDelay: '0.6s' }} />
      <span aria-hidden className="pointer-events-none absolute bottom-[22%] left-[10%] w-1.5 h-1.5 rounded-full bg-sky-400/60 blur-[1px] animate-pulse" style={{ animationDelay: '1.1s' }} />
      <span aria-hidden className="pointer-events-none absolute bottom-[16%] right-[16%] w-2 h-2 rounded-full bg-indigo-300/60 blur-[1px] animate-pulse" style={{ animationDelay: '1.6s' }} />

      <div className="relative z-10 flex flex-col min-h-screen">
        {/* top bar — brand left, Log In trigger right */}
        <header className="w-full flex items-center justify-between px-6 sm:px-10 py-6 lg:py-8">
          <div className="flex items-center gap-3">
            <div className="bg-white p-2.5 rounded-xl shadow-md">
              <Logo size={26} />
            </div>
            <div className="text-left hidden sm:block">
              <div className="text-sm font-bold tracking-wider text-slate-100 uppercase">Search Analytics AI</div>
              <div className="text-xs text-indigo-400 font-semibold">by Zunkiree Labs</div>
            </div>
            <span className="ml-1 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
              <Sparkles size={10} strokeWidth={2.5} /> AI Powered
            </span>
          </div>

          <button type="button" onClick={() => setShowLogin(true)}
            className="inline-flex items-center gap-2 text-sm font-semibold text-white bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.14] backdrop-blur-sm rounded-xl px-4 py-2.5 transition">
            <LogIn size={15} strokeWidth={2.25} /> Log In
          </button>
        </header>

        {/* hero content — centered; headline/description stay reading-width,
            the workspace preview breaks out much wider so the page doesn't
            look flat with dead space down the sides. */}
        <div className="flex-1 flex flex-col items-center text-center px-6 pb-16 pt-4 lg:pt-8 w-full">
          <h1 className="text-4xl lg:text-[2.9rem] font-extrabold tracking-tight text-white leading-[1.12] mb-5 max-w-3xl">
            Turn Search Data Into{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
              Organic Growth.
            </span>
          </h1>
          <p className="text-slate-400 text-[15px] leading-relaxed max-w-md mb-8">
            AI agents continuously analyze your Google Search Console and Google Analytics data — surfacing ranking opportunities, content gaps, and growth signals automatically, day and night.
          </p>

          {/* Live AI workspace preview */}
          <div className="w-full max-w-6xl">
            <WorkspacePreview />
          </div>

          {/* Capability chips */}
          <div className="flex flex-wrap items-center justify-center gap-2.5 mt-8">
            {PILLS.map((p) => (
              <span key={p} className="inline-flex items-center gap-1.5 text-xs text-slate-300 bg-white/5 border border-white/10 backdrop-blur-sm rounded-full px-3.5 py-2">
                <Check size={13} strokeWidth={2.5} className="text-emerald-400" /> {p}
              </span>
            ))}
          </div>
        </div>
      </div>

      {showLogin && <LoginModal onClose={() => setShowLogin(false)} onAuthed={onAuthed} />}
    </div>
  );
}

/* ───────────────────────── LOGIN MODAL ───────────────────────── */

function LoginModal({ onClose, onAuthed }) {
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
    } catch {
      setErr('Invalid email or password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div aria-hidden className="absolute inset-0 bg-[#050810]/75 backdrop-blur-md" />

      <div onClick={(e) => e.stopPropagation()}
        className="w-full rounded-[24px] p-8 lg:p-10 shadow-2xl relative overflow-hidden backdrop-blur-xl fade-up"
        style={{ maxWidth: 430, background: 'rgba(15,21,48,0.92)', border: '1px solid rgba(255,255,255,0.12)' }}>

        <div className="absolute -top-24 -left-24 w-48 h-48 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />

        <button type="button" onClick={onClose} aria-label="Close"
          className="absolute top-4 right-4 z-10 w-8 h-8 rounded-lg grid place-items-center text-slate-400 hover:text-white hover:bg-white/[0.08] transition">
          <X size={16} strokeWidth={2.25} />
        </button>

        <div className="relative z-[1]">
          <div className="mb-3 flex justify-center">
            <div className="bg-white p-4 rounded-2xl shadow-lg">
              <Logo size={38} />
            </div>
          </div>
          <div className="text-center">
            <div className="text-sm font-bold text-white tracking-wide">Search Analytics AI</div>
            <div className="text-[10px] text-indigo-300 font-bold uppercase tracking-wider mt-1">Enterprise Workspace</div>
          </div>

          <div className="text-center mt-6 mb-8">
            <h2 className="text-2xl font-extrabold text-white">Welcome Back</h2>
            <p className="text-sm text-slate-400 mt-2">Sign in with your email and password to access your workspace.</p>
          </div>

          <form onSubmit={submit} className="space-y-5">
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Email</label>
              <input
                type="email"
                autoFocus
                autoComplete="username"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full bg-slate-950/60 border border-slate-800/80 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 text-white rounded-xl px-4 py-3.5 text-sm transition-all placeholder-slate-700"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Password</label>
              <div className="relative">
                <input
                  type="password"
                  autoComplete="current-password"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••••"
                  className="w-full bg-slate-950/60 border border-slate-800/80 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 text-white rounded-xl px-4 py-3.5 text-sm transition-all placeholder-slate-700"
                />
                <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-600">
                  <Lock size={16} strokeWidth={2} />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs">
              <label className="flex items-center gap-2 text-slate-400 cursor-pointer select-none">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-indigo-500 cursor-pointer" />
                Remember Me
              </label>
              <button type="button" onClick={() => setShowForgot((s) => !s)}
                className="text-indigo-400 hover:text-indigo-300 font-semibold">
                Forgot Password?
              </button>
            </div>
            {showForgot && (
              <p className="text-xs text-slate-500 bg-white/[0.03] border border-white/5 rounded-xl px-3.5 py-2.5 -mt-2">
                Contact your workspace admin to reset your password.
              </p>
            )}

            {err && (
              <div className="bg-rose-500/10 border border-rose-500/20 text-rose-300 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                <AlertCircle size={16} strokeWidth={2} className="shrink-0" />
                <span>{err}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold py-3.5 rounded-xl text-sm shadow-lg shadow-indigo-500/20 transition duration-200 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {busy ? (
                <>
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Decrypting Database...
                </>
              ) : (
                <>Access Workspace <ArrowRight size={15} strokeWidth={2.5} /></>
              )}
            </button>
          </form>

          <div className="mt-7 pt-6 border-t border-slate-800/60 flex flex-col items-center gap-1.5 text-[11px] text-slate-400">
            <span className="flex items-center gap-1.5"><ShieldCheck size={12} strokeWidth={2.5} className="text-emerald-400/90" /> Secure Multi-Tenant Platform</span>
            <span className="flex items-center gap-1.5"><Lock size={12} strokeWidth={2.5} className="text-emerald-400/90" /> Encrypted Authentication</span>
            <span className="text-slate-500 mt-1">Powered by Zunkiree Labs</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── LIVE AI WORKSPACE PREVIEW ───────────────────────── */

function WorkspacePreview() {
  return (
    <div className="w-full rounded-[28px] p-5 lg:p-6 text-left backdrop-blur-xl relative overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.065)', border: '1px solid rgba(255,255,255,0.14)', boxShadow: '0 24px 60px -20px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)' }}>

      {/* header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="relative flex w-2 h-2">
            <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
            <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-400" />
          </span>
          <span className="text-xs font-bold text-white tracking-wide">AI Agent Activity</span>
        </div>
        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-2.5 py-1">
          <Sparkles size={10} strokeWidth={2.5} /> Live
        </span>
      </div>

      {/* agent rows — 2-column grid once there's room, so the wider panel
          reads as a balanced dashboard grid instead of one long stretched list */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-0.5">
        {AGENTS.map((a) => <AgentRow key={a.name} {...a} />)}
      </div>

      {/* metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 pt-4 border-t border-white/[0.06]">
        {METRICS.map((m) => <MetricTile key={m.label} {...m} />)}
      </div>

      {/* trend chart */}
      <div className="mt-3 bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-bold text-slate-300">Organic Visibility Trend</span>
          <span className="text-[9px] text-emerald-400 font-bold">+18% ▲</span>
        </div>
        <PreviewChart />
      </div>
    </div>
  );
}

function AgentRow({ icon: Icon, name, status, progress, text }) {
  const running = status === 'running';
  return (
    <div className="flex items-start gap-2.5 rounded-xl px-2 py-2 hover:bg-white/[0.03] transition">
      <span className="relative flex w-6 h-6 rounded-lg items-center justify-center shrink-0 mt-0.5"
        style={{ background: running ? 'rgba(129,140,248,0.15)' : 'rgba(52,211,153,0.15)' }}>
        <Icon size={12} strokeWidth={2.25} style={{ color: running ? '#a5b4fc' : '#6ee7b7' }} />
        {running && (
          <span className="absolute -top-0.5 -right-0.5 flex w-2 h-2">
            <span className="absolute inline-flex w-full h-full rounded-full bg-indigo-400 opacity-75 animate-ping" />
            <span className="relative inline-flex w-2 h-2 rounded-full bg-indigo-400" />
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-semibold text-white truncate">{name}</span>
          <span className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0 ${
            running ? 'text-indigo-300 bg-indigo-500/10' : 'text-emerald-300 bg-emerald-500/10'
          }`}>
            {running ? 'Running…' : 'Completed'}
          </span>
        </div>
        <p className="text-[10.5px] text-slate-400 leading-snug mt-0.5">{text}</p>
        {running && (
          <div className="mt-1.5 h-1 rounded-full bg-white/[0.06] overflow-hidden relative">
            {progress != null ? (
              <div className="h-full rounded-full" style={{ width: `${progress}%`, background: 'linear-gradient(90deg,#6C63FF,#a78bfa)' }} />
            ) : (
              <div className="absolute inset-y-0 left-0 w-1/3 rounded-full shimmer-sweep"
                style={{ background: 'linear-gradient(90deg,transparent,#a78bfa,transparent)' }} />
            )}
          </div>
        )}
      </div>
      {progress != null && <span className="text-[10px] font-bold text-indigo-300 shrink-0 mt-0.5">{progress}%</span>}
    </div>
  );
}

function MetricTile({ label, value, color }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-2.5 py-2">
      <div className="text-[8.5px] text-slate-300 font-semibold uppercase tracking-wide leading-tight" style={{ minHeight: '2.2em' }}>{label}</div>
      <div className="text-sm font-black mt-0.5" style={{ color }}>{value}</div>
    </div>
  );
}

function PreviewChart() {
  return (
    <svg viewBox="0 0 280 44" className="w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="loginPreviewFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.35" />
          <stop offset="1" stopColor="#8b5cf6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0,34 28,29 56,31 84,20 112,24 140,14 168,19 196,9 224,15 252,4 280,10 280,44 0,44 Z" fill="url(#loginPreviewFill)" />
      <polyline points="0,34 28,29 56,31 84,20 112,24 140,14 168,19 196,9 224,15 252,4 280,10"
        fill="none" stroke="#a78bfa" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
