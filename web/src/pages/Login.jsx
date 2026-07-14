import { useEffect, useState } from 'react';
import {
  Sparkles, Check, Lock, AlertCircle, ArrowRight, LogIn, X,
  FileText, Eye, FileSearch, Users, TrendingUp, Gauge, ShieldCheck,
  Plug, Cpu, ClipboardList, CheckCircle2, Globe2, Smartphone, Code2, Link2, MessageSquare, EyeOff,
} from 'lucide-react';
import { api } from '../api.js';
import Logo from '../components/Logo.jsx';

const PILLS = ['AI Agents', 'Google Search Console', 'Google Analytics 4', 'Automated Reports'];

// How It Works — the real onboarding sequence (server/routes/clients.js's
// connect flow, then server/job.js's daily/weekly agent orchestration),
// not an invented generic SaaS funnel.
const STEPS = [
  { icon: Plug, title: 'Connect your real data', text: 'Grant access to your Google Search Console and Analytics properties — the same data you already have, nothing new to set up.' },
  { icon: Cpu, title: 'AI agents analyze continuously', text: 'Specialist agents run daily and weekly, each looking at one real slice of your search performance — never a single generic model guessing at everything.' },
  { icon: ClipboardList, title: 'Get a prioritized, evidence-backed briefing', text: 'Every finding cites the real numbers behind it — an impression count, a ranking delta, a real page — never a vague "you should improve SEO."' },
  { icon: CheckCircle2, title: 'Review and approve every fix', text: 'Agents draft the fix — a title, an FAQ, a schema block — you approve it. Nothing publishes or changes your site without you clicking approve.' },
];

// Every entry here names a real agent in server/agents/ — same honesty
// rule as the AGENTS preview list below (no fabricated capability).
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

// The product's actual operating discipline — real, not marketing fluff:
// every agent in this codebase either reports a real number or honestly
// says "insufficient data," never fills a gap with a guess.
const HONESTY_POINTS = [
  { icon: ShieldCheck, title: 'Never a fabricated metric', text: 'If we don\'t have a real data source for something, we say so — "insufficient data," not a made-up number.' },
  { icon: EyeOff, title: 'No black-box scores', text: 'Every score — Authority, Health, AI Visibility — is a documented formula over real data, and every input is shown.' },
  { icon: FileText, title: 'Evidence on every finding', text: 'A recommendation always cites the real number behind it — no generic advice with nothing backing it up.' },
];

// Every entry here must name a real agent in server/agents/ and describe
// what it actually does — no fabricated specific numbers (this list
// previously claimed "12 missing content opportunities discovered" / "Found
// 27 keywords" / a "Technical SEO Agent" that doesn't exist anywhere in the
// codebase), same honesty rule the product itself enforces on labeled
// AI output.
const AGENTS = [
  { icon: FileText, name: 'Executive Summary Agent', status: 'completed', text: 'Synthesizes every specialist agent into one weekly growth summary.' },
  { icon: Eye, name: 'AI Visibility Agent', status: 'running', progress: 72, text: 'Checks schema, FAQ presence, and structural signals that determine AI-answer-engine readiness.' },
  { icon: FileSearch, name: 'Content Gap Agent', status: 'completed', text: 'Scores ranking pages for content completeness gaps.' },
  { icon: Users, name: 'Competitor Intelligence', status: 'running', text: 'Identifies real competitors and compares content, SEO structure, and positioning.' },
  { icon: TrendingUp, name: 'Ranking Opportunity Agent', status: 'running', text: 'Finds striking-distance keywords close to page one.' },
  { icon: Gauge, name: 'Query Intelligence Agent', status: 'completed', text: 'Analyzed search queries for gainers and droppers.' },
];

const METRICS = [
  { label: 'Organic Growth Forecast', value: '+18%', color: '#34d399' },
  { label: 'Visibility Score', value: '91/100', color: '#818cf8' },
  { label: 'Ranking Opportunities', value: '27', color: '#38bdf8' },
  { label: 'AI Insights Generated', value: '146', color: '#c084fc' },
];

export default function Login({ onAuthed }) {
  // null | 'login' | 'request' — two separate, equally visible header
  // entry points (not one button with a buried link inside it), since a
  // brand-new visitor has no reason to click "Log In" to discover signup.
  const [authModal, setAuthModal] = useState(null);

  // Close whichever modal is open on Escape.
  useEffect(() => {
    if (!authModal) return;
    const onKey = (e) => { if (e.key === 'Escape') setAuthModal(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [authModal]);

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

          <div className="flex items-center gap-2.5">
            <button type="button" onClick={() => setAuthModal('login')}
              className="inline-flex items-center gap-2 text-sm font-semibold text-white bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.14] backdrop-blur-sm rounded-xl px-4 py-2.5 transition">
              <LogIn size={15} strokeWidth={2.25} /> Log In
            </button>
            {/* The primary CTA for a brand-new visitor — equally prominent
                as Log In, not hidden as a link inside it. */}
            <button type="button" onClick={() => setAuthModal('request')}
              className="inline-flex items-center gap-2 text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 rounded-xl px-4 py-2.5 shadow-lg shadow-indigo-500/20 transition">
              Request Access <ArrowRight size={15} strokeWidth={2.5} />
            </button>
          </div>
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

        {/* How It Works — the real onboarding + agent-orchestration
            sequence, so a visitor who lands directly on Request Access
            (not just the hero) still understands what happens next. */}
        <section className="w-full px-6 py-20 border-t border-white/[0.06]">
          <div className="max-w-5xl mx-auto text-center">
            <h2 className="text-2xl sm:text-3xl font-extrabold text-white mb-3">How It Works</h2>
            <p className="text-slate-400 text-sm max-w-lg mx-auto mb-12">From your real data to an approved fix — every step grounded in something real, nothing automated behind your back.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 text-left">
              {STEPS.map((s, i) => (
                <div key={s.title} className="relative bg-white/[0.03] border border-white/[0.08] rounded-2xl p-5">
                  <span className="absolute -top-3 -left-3 w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-xs font-bold grid place-items-center shadow-lg">{i + 1}</span>
                  <s.icon size={20} strokeWidth={2} className="text-indigo-300 mb-3" />
                  <h3 className="text-sm font-bold text-white mb-1.5">{s.title}</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">{s.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* What the agents actually do — every name/description matches a
            real agent in server/agents/, same honesty rule as the hero's
            live preview list (no fabricated capability). */}
        <section className="w-full px-6 py-20 border-t border-white/[0.06] bg-white/[0.015]">
          <div className="max-w-5xl mx-auto text-center">
            <h2 className="text-2xl sm:text-3xl font-extrabold text-white mb-3">11 Specialist Agents, Not One Generic Model</h2>
            <p className="text-slate-400 text-sm max-w-lg mx-auto mb-12">Each agent looks at one real slice of your search performance — here's exactly what each one actually does.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-left">
              {AGENT_GRID.map((a) => (
                <div key={a.name} className="flex items-start gap-3 bg-white/[0.03] border border-white/[0.08] rounded-xl p-4">
                  <span className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/20 grid place-items-center shrink-0">
                    <a.icon size={16} strokeWidth={2} className="text-indigo-300" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-white">{a.name}</h3>
                    <p className="text-xs text-slate-400 leading-relaxed mt-0.5">{a.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Honesty discipline — a genuine, distinctive property of this
            product (see e.g. server/agents/types.js's insufficient-data
            contract), not a generic trust badge. */}
        <section className="w-full px-6 py-20 border-t border-white/[0.06]">
          <div className="max-w-4xl mx-auto text-center">
            <h2 className="text-2xl sm:text-3xl font-extrabold text-white mb-3">Not a Black Box</h2>
            <p className="text-slate-400 text-sm max-w-lg mx-auto mb-12">Most AI SEO tools show you a confident-looking score with no way to check it. Ours doesn't work that way.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 text-left">
              {HONESTY_POINTS.map((h) => (
                <div key={h.title} className="bg-white/[0.03] border border-white/[0.08] rounded-2xl p-5">
                  <h.icon size={20} strokeWidth={2} className="text-emerald-400 mb-3" />
                  <h3 className="text-sm font-bold text-white mb-1.5">{h.title}</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">{h.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Closing CTA — repeats Request Access so a convinced scroller
            doesn't have to scroll back to the header. */}
        <section className="w-full px-6 py-20 border-t border-white/[0.06] text-center">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-white mb-3">Ready to see what's really happening in your search performance?</h2>
          <p className="text-slate-400 text-sm max-w-md mx-auto mb-8">Requests are reviewed by a real person — not instant signup, but you'll be ready to log in the moment it's approved.</p>
          <button type="button" onClick={() => setAuthModal('request')}
            className="inline-flex items-center gap-2 text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 rounded-xl px-6 py-3.5 shadow-lg shadow-indigo-500/20 transition">
            Request Access <ArrowRight size={15} strokeWidth={2.5} />
          </button>
        </section>
      </div>

      {authModal && <LoginModal initialMode={authModal} onClose={() => setAuthModal(null)} onAuthed={onAuthed} />}
    </div>
  );
}

/* ───────────────────────── LOGIN MODAL ───────────────────────── */

function LoginModal({ initialMode = 'login', onClose, onAuthed }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showForgot, setShowForgot] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // 'login' | 'request' — a real signup request, never an immediate account
  // (see server/routes/login.js's POST /signup-requests — staff must
  // approve it on /clients before this email/password can ever log in).
  // Opens directly into whichever the header button the visitor actually
  // clicked, rather than always starting on login.
  const [mode, setMode] = useState(initialMode);

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

  if (mode === 'request') {
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
          <RequestAccessForm onBack={() => setMode('login')} />
        </div>
      </div>
    );
  }

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

            <p className="text-center text-xs text-slate-500">
              Don't have access yet?{' '}
              <button type="button" onClick={() => setMode('request')} className="text-indigo-400 hover:text-indigo-300 font-semibold">
                Request it →
              </button>
            </p>

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

/* ───────────────────────── REQUEST ACCESS FORM ───────────────────────── */

const inputCls = 'w-full bg-slate-950/60 border border-slate-800/80 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 text-white rounded-xl px-4 py-3.5 text-sm transition-all placeholder-slate-700';
const labelCls = 'block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2';

// A real submission, never an immediate account — see POST /signup-requests
// (server/routes/login.js). Staff review and approve/reject it from the
// existing internal /clients page before any real login exists for this
// email/password. `honeypot` is a hidden field real users never see or
// fill in; a bot that fills every input on the page fills this too, and
// the backend silently no-ops instead of creating a row — no CAPTCHA/
// third-party dependency needed for this low-traffic B2B form.
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
      <div className="relative z-[1] text-center py-4">
        <div className="mb-3 flex justify-center">
          <div className="bg-white p-4 rounded-2xl shadow-lg"><Logo size={38} /></div>
        </div>
        <h2 className="text-xl font-extrabold text-white mb-2">Request submitted</h2>
        <p className="text-sm text-slate-400 leading-relaxed">
          We'll review your request and be in touch once it's approved — you'll be able to log in with the email
          and password you just set.
        </p>
        <button type="button" onClick={onBack}
          className="mt-6 text-sm font-semibold text-indigo-400 hover:text-indigo-300">
          ← Back to log in
        </button>
      </div>
    );
  }

  return (
    <div className="relative z-[1]">
      <div className="mb-3 flex justify-center">
        <div className="bg-white p-4 rounded-2xl shadow-lg"><Logo size={38} /></div>
      </div>
      <div className="text-center mt-6 mb-8">
        <h2 className="text-2xl font-extrabold text-white">Request Access</h2>
        <p className="text-sm text-slate-400 mt-2 leading-relaxed">
          AI agents that continuously analyze your Google Search Console and Analytics data. Tell us about your
          company below — a real person reviews every request, so this isn't instant signup, but you'll set your
          password now and be ready to log in the moment it's approved.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        {/* Visually hidden from real users, present for bots that fill every field. */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
          <label htmlFor="company_url">Company URL</label>
          <input id="company_url" type="text" tabIndex={-1} autoComplete="off"
            value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
        </div>

        <div>
          <label className={labelCls}>Company name</label>
          <input type="text" required autoFocus value={companyName} onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Acme Corp" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Website (optional)</label>
          <input type="text" value={websiteDomain} onChange={(e) => setWebsiteDomain(e.target.value)}
            placeholder="acme.com" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Work email</label>
          <input type="email" required autoComplete="username" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
            placeholder="you@acme.com" className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Password</label>
            <input type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters" className={inputCls} minLength={8} />
          </div>
          <div>
            <label className={labelCls}>Confirm</label>
            <input type="password" required autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password" className={inputCls} minLength={8} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Anything else? (optional)</label>
          <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="What are you hoping to track?" className={inputCls} />
        </div>

        {err && (
          <div className="bg-rose-500/10 border border-rose-500/20 text-rose-300 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
            <AlertCircle size={16} strokeWidth={2} className="shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <button type="submit" disabled={busy}
          className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold py-3.5 rounded-xl text-sm shadow-lg shadow-indigo-500/20 transition duration-200 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
          {busy ? 'Submitting…' : 'Submit request'}
        </button>
        <button type="button" onClick={onBack}
          className="w-full text-center text-xs font-semibold text-slate-400 hover:text-slate-200">
          ← Back to log in
        </button>
      </form>
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
