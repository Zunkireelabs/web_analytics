import { Link } from 'react-router-dom';
import Logo from '../components/Logo.jsx';

const PURPLE = '#6C63FF';
const GRAD = 'linear-gradient(135deg,#6C63FF,#8b5cf6)';

// Landing page — built to match the finalized Zunkiree Labs design.
export default function Home() {
  return (
    <div className="relative overflow-hidden bg-gradient-to-b from-white to-slate-50">
      {/* soft glows */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 right-0 w-[680px] h-[680px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(108,99,255,0.16), transparent 60%)' }} />
        <div className="absolute top-60 -left-24 w-[460px] h-[460px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.14), transparent 60%)' }} />
      </div>

      {/* ── HERO ── */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-12 pb-16 grid lg:grid-cols-[0.9fr_1.1fr] gap-10 items-center">
        {/* Left */}
        <div>
          <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight text-slate-900 leading-[1.05]">
            Turn Search Data<br />Into{' '}
            <span className="relative inline-block">
              <span className="bg-gradient-to-r from-[#6C63FF] to-blue-500 bg-clip-text text-transparent">Growth</span>
              <svg className="absolute -bottom-2 left-0 w-full" height="10" viewBox="0 0 200 10" preserveAspectRatio="none">
                <path d="M2 7 C 60 1, 140 1, 198 6" fill="none" stroke="#8b5cf6" strokeWidth="3" strokeLinecap="round" opacity="0.55" />
              </svg>
            </span>
          </h1>

          <p className="text-lg text-slate-500 mt-6 max-w-xl leading-relaxed">
            Track rankings, traffic, keywords, countries, devices, and AI-powered insights
            from one unified dashboard.
          </p>

          {/* CTAs */}
          <div className="flex flex-wrap items-center gap-3 mt-8">
            <Link to="/overview"
              className="inline-flex items-center gap-2 text-white font-semibold rounded-xl px-6 py-3.5 shadow-lg shadow-indigo-500/30 hover:opacity-95 transition"
              style={{ background: GRAD }}>
              <span>🚀</span> Launch Analytics →
            </Link>
            <Link to="/insights"
              className="inline-flex items-center gap-2 font-semibold rounded-xl px-6 py-3.5 border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:shadow-sm transition">
              <span>▷</span> View Sample Report
            </Link>
          </div>

          {/* Trust badge cards — all four on one row */}
          <div className="grid grid-cols-4 gap-2 mt-8 max-w-2xl">
            <TrustBadge icon={<GSCIcon />} title="Google Search Console" status="Connected" />
            <TrustBadge icon={<GA4Icon />} title="Google Analytics 4" status="Connected" />
            <TrustBadge icon={<span className="text-sm">✨</span>} title="AI-Powered Insights" status="Active" />
            <TrustBadge icon={<span className="text-sm">📄</span>} title="Weekly Reports" status="Automated" />
          </div>

          {/* trust line */}
          <div className="flex items-center gap-4 mt-6 text-xs text-slate-400">
            <span>🔒 Secure. Private. 100% your data.</span>
            <span className="w-px h-3 bg-slate-200" />
            <span>Trusted by data-driven teams</span>
          </div>
        </div>

        {/* Right: dashboard mockup */}
        <div className="relative">
          <div className="absolute -inset-8 rounded-[36px] blur-2xl -z-10"
            style={{ background: 'radial-gradient(circle at 50% 30%, rgba(108,99,255,0.26), transparent 70%)' }} />
          <DashboardMock />
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pb-24">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-5">
          {FEATURES.map((f) => (
            <div key={f.title} className="card card-hover p-5">
              <div className="w-10 h-10 rounded-xl grid place-items-center mb-3"
                style={{ background: 'rgba(108,99,255,0.1)', color: PURPLE }}>{f.icon}</div>
              <div className="font-semibold text-slate-900">{f.title}</div>
              <p className="text-sm text-slate-500 mt-1 leading-relaxed">{f.desc}</p>
              <Link to={f.to} className="inline-block mt-3 text-sm font-medium" style={{ color: PURPLE }}>Explore →</Link>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function TrustBadge({ icon, title, status }) {
  return (
    <div className="flex items-center gap-2 bg-white border border-slate-100 rounded-xl px-2.5 py-2 shadow-sm">
      <span className="shrink-0 grid place-items-center">{icon}</span>
      <div className="leading-tight min-w-0">
        <div className="text-[10px] font-semibold text-slate-700 leading-snug">{title}</div>
        <div className="text-[9px] text-emerald-600 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />{status}
        </div>
      </div>
    </div>
  );
}

// Stylized integration marks (brand-colored, not exact logos).
function GSCIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-label="Search Console">
      <circle cx="10" cy="10" r="6.5" fill="#fff" stroke="#4285F4" strokeWidth="2" />
      <rect x="7" y="9.5" width="1.8" height="3.5" rx="0.6" fill="#34A853" />
      <rect x="9.6" y="7.5" width="1.8" height="5.5" rx="0.6" fill="#FBBC05" />
      <rect x="12.2" y="10.5" width="1.8" height="2.5" rx="0.6" fill="#EA4335" />
      <line x1="14.8" y1="14.8" x2="20" y2="20" stroke="#4285F4" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
function GA4Icon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-label="Analytics">
      <rect x="4" y="13" width="4" height="7" rx="1.5" fill="#F9AB00" />
      <rect x="10" y="9" width="4" height="11" rx="1.5" fill="#E37400" />
      <rect x="16" y="5" width="4" height="15" rx="1.5" fill="#F9AB00" />
    </svg>
  );
}

/* ───────────────────────── Dashboard mockup ───────────────────────── */

const NAV = ['Overview', 'Performance', 'Keywords', 'Pages', 'Countries', 'Devices', 'AI Insights', 'Reports', 'Settings'];

function DashboardMock() {
  return (
    <div className="relative rounded-[24px] bg-white border border-slate-100 shadow-2xl overflow-hidden">
      {/* top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Logo size={20} />
          <span className="text-xs font-bold tracking-wide text-slate-700">ZUNKIREE&nbsp;LABS</span>
        </div>
        <span className="text-[11px] text-slate-400 bg-slate-50 rounded-md px-2.5 py-1">Jun 1 – Jun 30, 2026</span>
      </div>

      <div className="flex">
        {/* sidebar */}
        <div className="w-32 shrink-0 border-r border-slate-100 py-4 px-2.5">
          {NAV.map((n, i) => (
            <div key={n}
              className={`text-[11px] rounded-lg px-2.5 py-2 mb-0.5 ${i === 0 ? 'font-semibold' : 'text-slate-500'}`}
              style={i === 0 ? { background: 'rgba(108,99,255,0.1)', color: PURPLE } : undefined}>
              {n}
            </div>
          ))}
          <div className="text-[9px] text-slate-300 mt-4 px-2.5">Last updated 5:23 AM</div>
        </div>

        {/* main */}
        <div className="flex-1 p-4 bg-slate-50/40">
          {/* stat cards with mini sparklines */}
          <div className="grid grid-cols-4 gap-2.5">
            <MiniStat label="Total Clicks" value="24.5K" delta="+12.5%" color="#10b981" />
            <MiniStat label="Total Impressions" value="1.2M" delta="+8.3%" color="#6C63FF" />
            <MiniStat label="Average CTR" value="2.04%" delta="+0.5%" color="#0ea5e9" />
            <MiniStat label="Average Position" value="18.6" delta="-1.1" color="#f59e0b" />
          </div>

          {/* performance chart */}
          <div className="bg-white rounded-xl border border-slate-100 p-3.5 mt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-700">Performance Over Time</span>
              <span className="text-[10px] text-slate-400 border border-slate-100 rounded-md px-2 py-1">Last 7 days ▾</span>
            </div>
            <PerfChart />
            <div className="flex items-center gap-4 mt-1.5 text-[10px] text-slate-500">
              <span className="flex items-center gap-1"><span className="w-3 h-[2px] rounded" style={{ background: PURPLE }} /> Clicks</span>
              <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed border-indigo-300" /> Impressions</span>
            </div>
          </div>

          {/* countries + devices */}
          <div className="grid grid-cols-2 gap-2.5 mt-3">
            <div className="bg-white rounded-xl border border-slate-100 p-3.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-700">Top Countries</span>
                <span className="text-[10px]" style={{ color: PURPLE }}>View all</span>
              </div>
              {[['🇺🇸', 'United States', '12.5K'], ['🇮🇳', 'India', '9.4K'], ['🇬🇧', 'United Kingdom', '6.1K'], ['🇩🇪', 'Germany', '4.0K'], ['🇨🇦', 'Canada', '3.3K']].map(([fl, c, v]) => (
                <div key={c} className="flex items-center justify-between text-[11px] mb-1.5">
                  <span className="flex items-center gap-1.5 text-slate-600 truncate"><span>{fl}</span>{c}</span>
                  <span className="font-semibold text-slate-800">{v}</span>
                </div>
              ))}
            </div>
            <div className="bg-white rounded-xl border border-slate-100 p-3.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-700">Top Devices</span>
                <span className="text-[10px]" style={{ color: PURPLE }}>View all</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-20 h-20 rounded-full shrink-0"
                  style={{ background: `conic-gradient(${PURPLE} 0 58%, #0ea5e9 58% 82%, #f59e0b 82% 100%)` }}>
                  <div className="w-10 h-10 rounded-full bg-white m-5" />
                </div>
                <div className="text-[11px] space-y-1.5">
                  <Leg color={PURPLE} t="Mobile" v="58%" />
                  <Leg color="#0ea5e9" t="Desktop" v="24%" />
                  <Leg color="#f59e0b" t="Tablet" v="18%" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, delta, color }) {
  const good = !delta.startsWith('-') || label === 'Average Position';
  return (
    <div className="bg-white rounded-xl border border-slate-100 p-2.5">
      <div className="text-[9px] text-slate-400 truncate">{label}</div>
      <div className="text-base font-bold text-slate-900 leading-tight mt-0.5">{value}</div>
      <div className="flex items-center justify-between mt-1">
        <span className={`text-[9px] ${good ? 'text-emerald-600' : 'text-rose-500'}`}>{delta}</span>
        <Spark color={color} />
      </div>
    </div>
  );
}

function Spark({ color }) {
  return (
    <svg width="40" height="14" viewBox="0 0 40 14" fill="none">
      <polyline points="0,11 7,8 14,9 21,4 28,6 35,2 40,5"
        stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Leg({ color, t, v }) {
  return (
    <div className="flex items-center gap-1.5 text-slate-600">
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />{t}
      <span className="text-slate-400">{v}</span>
    </div>
  );
}

function PerfChart() {
  return (
    <svg viewBox="0 0 300 90" className="w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="pm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6C63FF" stopOpacity="0.22" />
          <stop offset="1" stopColor="#6C63FF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0,68 30,58 60,62 90,42 120,50 150,30 180,40 210,22 240,32 270,14 300,24 300,90 0,90 Z" fill="url(#pm)" />
      <polyline points="0,68 30,58 60,62 90,42 120,50 150,30 180,40 210,22 240,32 270,14 300,24"
        fill="none" stroke="#6C63FF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="0,80 30,74 60,77 90,68 120,72 150,62 180,70 210,58 240,64 270,52 300,60"
        fill="none" stroke="#c7d2fe" strokeWidth="1.8" strokeDasharray="4 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ───────────────────────── Feature cards ───────────────────────── */

const FEATURES = [
  { title: 'Real-time Performance', desc: 'Track clicks, impressions, CTR, and average position daily.', icon: '📈', to: '/overview' },
  { title: 'Keyword Insights', desc: 'Monitor keyword rankings and discover new opportunities.', icon: '🔑', to: '/insights' },
  { title: 'Countries & Devices', desc: 'See where your visitors are and how they access your site.', icon: '🌐', to: '/insights' },
  { title: 'AI-Powered Insights', desc: 'Get smart recommendations to grow your organic traffic.', icon: '✨', to: '/overview' },
  { title: 'Automated Reports', desc: 'Weekly reports built and saved for you automatically.', icon: '📄', to: '/compare' },
];
