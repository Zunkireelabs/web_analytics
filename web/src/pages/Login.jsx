import { useState } from 'react';
import { Sparkles, Check, Lock, AlertCircle, ArrowRight } from 'lucide-react';
import { api } from '../api.js';
import Logo from '../components/Logo.jsx';

const PILLS = ['Google Search Console', 'Google Analytics 4', 'AI Insights', 'Daily Reports'];

export default function Login({ onAuthed }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    <div className="min-h-screen flex flex-col lg:flex-row font-sans">

      {/* LEFT: hero — logo, headline, illustration, feature pills */}
      <div className="relative lg:w-[58%] flex flex-col items-center justify-center overflow-hidden px-8 py-16 lg:p-16"
        style={{ background: 'linear-gradient(160deg, #0B1020 0%, #101A3A 100%)' }}>

        {/* faint dotted grid */}
        <div aria-hidden className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px)', backgroundSize: '26px 26px' }} />

        {/* purple radial glow behind the illustration */}
        <div aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[640px] h-[640px] rounded-full blur-[120px] bg-indigo-500/25" />
        <div aria-hidden className="pointer-events-none absolute -top-32 -left-24 w-[420px] h-[420px] rounded-full blur-[120px] bg-purple-500/10" />

        {/* floating glow particles */}
        <span aria-hidden className="pointer-events-none absolute top-[18%] left-[20%] w-2 h-2 rounded-full bg-indigo-400/70 blur-[1px] animate-pulse" />
        <span aria-hidden className="pointer-events-none absolute top-[30%] right-[16%] w-1.5 h-1.5 rounded-full bg-purple-400/70 blur-[1px] animate-pulse" style={{ animationDelay: '0.6s' }} />
        <span aria-hidden className="pointer-events-none absolute bottom-[28%] left-[14%] w-1.5 h-1.5 rounded-full bg-sky-400/60 blur-[1px] animate-pulse" style={{ animationDelay: '1.1s' }} />
        <span aria-hidden className="pointer-events-none absolute bottom-[20%] right-[22%] w-2 h-2 rounded-full bg-indigo-300/60 blur-[1px] animate-pulse" style={{ animationDelay: '1.6s' }} />

        <div className="relative z-10 w-full max-w-xl flex flex-col items-center text-center">
          {/* Logo row */}
          <div className="flex items-center gap-3 self-start mb-10">
            <div className="bg-white p-2.5 rounded-xl shadow-md">
              <Logo size={26} />
            </div>
            <div className="text-left">
              <div className="text-sm font-bold tracking-wider text-slate-100 uppercase">Search Analytics AI</div>
              <div className="text-xs text-indigo-400 font-semibold">by Zunkiree Labs</div>
            </div>
            <span className="ml-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
              <Sparkles size={10} strokeWidth={2.5} /> AI Powered
            </span>
          </div>

          {/* Headline + description, above the illustration */}
          <h1 className="text-4xl lg:text-[2.75rem] font-extrabold tracking-tight text-white leading-[1.12] mb-5">
            Turn Search Data Into{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
              Organic Growth.
            </span>
          </h1>
          <p className="text-slate-400 text-[15px] leading-relaxed max-w-md mb-10">
            Connect Google Search Console and Google Analytics to unlock AI-powered insights, ranking opportunities, daily reports, and performance monitoring from one secure workspace.
          </p>

          {/* Illustration — used exactly as provided, not redesigned */}
          <img src="/login-illustration.jpeg" alt="AI-powered search analytics: data & analysis, search visibility & growth, content & creation"
            className="w-[420px] max-w-full h-auto rounded-2xl shadow-2xl mb-10" style={{ width: 'clamp(420px, 34vw, 520px)' }} />

          {/* Feature pills */}
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            {PILLS.map((p) => (
              <span key={p} className="inline-flex items-center gap-1.5 text-xs text-slate-300 bg-white/5 border border-white/10 backdrop-blur-sm rounded-full px-3.5 py-2">
                <Check size={13} strokeWidth={2.5} className="text-emerald-400" /> {p}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* RIGHT: login card */}
      <div className="relative lg:w-[42%] flex items-center justify-center p-6 lg:p-12"
        style={{ background: '#0B1020' }}>
        <div className="w-full rounded-[24px] p-8 lg:p-10 shadow-2xl relative overflow-hidden"
          style={{ maxWidth: 430, background: '#0F1530', border: '1px solid rgba(255,255,255,0.06)' }}>

          <div className="absolute -top-24 -left-24 w-48 h-48 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />

          <div className="relative z-10">
            <div className="mb-6 flex justify-center">
              <div className="bg-white p-4 rounded-2xl shadow-lg">
                <Logo size={42} />
              </div>
            </div>

            <div className="text-center mb-8">
              <h2 className="text-2xl font-extrabold text-white">Welcome Back</h2>
              <p className="text-sm text-slate-400 mt-2">Sign in with your email and password to access your dashboard.</p>
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
                  <>Access Dashboard <ArrowRight size={15} strokeWidth={2.5} /></>
                )}
              </button>
            </form>

            <p className="text-center text-xs text-slate-500 mt-5">
              Forgot the password? Contact your workspace admin.
            </p>

            <div className="mt-6 text-center text-xs text-slate-500 border-t border-slate-800/60 pt-6 leading-relaxed">
              Protected Workspace<br />Private Analytics
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
