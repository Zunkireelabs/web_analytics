import { Link } from 'react-router-dom';
import Logo from '../components/Logo.jsx';

const PURPLE = '#6C63FF';
const GRAD = 'linear-gradient(135deg,#6C63FF,#8b5cf6)';

const NAV = [
  { label: 'Overview', icon: '📊' },
  { label: 'Performance', icon: '📈' },
  { label: 'Keywords', icon: '🔑' },
  { label: 'Pages', icon: '📄' },
  { label: 'Countries', icon: '🌐' },
  { label: 'Devices', icon: '📱' },
  { label: 'AI Insights', icon: '✨' },
  { label: 'Reports', icon: '📋' },
  { label: 'Settings', icon: '⚙️' }
];

export default function Home() {
  return (
    <div className="relative overflow-hidden bg-gradient-to-b from-[#FAF8FF] to-white min-h-screen">
      
      {/* Dynamic Background Glows */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 right-0 w-[800px] h-[800px] rounded-full blur-[140px]"
          style={{ background: 'radial-gradient(circle, rgba(108,99,255,0.08), transparent 70%)' }} />
        <div className="absolute top-80 -left-20 w-[600px] h-[600px] rounded-full blur-[120px]"
          style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.06), transparent 70%)' }} />
        
        {/* Soft grid background */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#6c63ff05_1px,transparent_1px),linear-gradient(to_bottom,#6c63ff05_1px,transparent_1px)] bg-[size:32px_32px] opacity-40" />
      </div>

      {/* ── HERO SECTION ── */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-16 pb-20 grid lg:grid-cols-[0.9fr_1.1fr] gap-12 items-center z-10 relative">
        
        {/* Hero Left Content */}
        <div className="space-y-6">
          {/* Pill Badge */}
          <div className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-600 border border-indigo-100 mb-2 select-none">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
            Unified GSC + GA4 Workspace
          </div>

          <h1 className="text-5xl md:text-6.5xl font-black tracking-tight text-slate-900 leading-[1.05]">
            Turn Search Data<br />Into{' '}
            <span className="relative inline-block mt-1">
              <span className="bg-gradient-to-r from-[#6C63FF] via-purple-500 to-pink-500 bg-clip-text text-transparent">Growth</span>
              <svg className="absolute -bottom-2 left-0 w-full" height="10" viewBox="0 0 200 10" preserveAspectRatio="none">
                <path d="M2 7 C 60 1, 140 1, 198 6" fill="none" stroke="#8b5cf6" strokeWidth="3.5" strokeLinecap="round" opacity="0.65" />
              </svg>
            </span>
          </h1>

          <p className="text-base sm:text-lg text-slate-500 max-w-xl leading-relaxed">
            Consolidate your rankings, traffic, keyword shifts, and devices. Get Claude-powered daily summaries and automatic reports delivered to your inbox.
          </p>

          {/* Action CTAs */}
          <div className="flex flex-wrap items-center gap-4 pt-2">
            <Link to="/overview"
              className="inline-flex items-center gap-2 text-white font-semibold rounded-2xl px-8 py-4 shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/35 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200"
              style={{ background: GRAD }}>
              <span>🚀</span> Launch Analytics →
            </Link>
            <Link to="/insights"
              className="inline-flex items-center gap-2 font-semibold rounded-2xl px-8 py-4 border border-slate-200 bg-white/80 backdrop-blur-sm text-slate-700 hover:border-slate-300 hover:bg-slate-50 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200">
              <span>▷</span> View Sample Report
            </Link>
          </div>

          {/* Integration Badges */}
          <div className="space-y-3 pt-4">
            <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Live Connections</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 max-w-2xl">
              <TrustBadge icon={<GSCIcon />} title="Google Search" status="Connected" />
              <TrustBadge icon={<GA4Icon />} title="Analytics 4" status="Connected" />
              <TrustBadge icon={<span className="text-sm">✨</span>} title="AI Summary" status="Active" />
              <TrustBadge icon={<span className="text-sm">📄</span>} title="Daily Reports" status="Automated" />
            </div>
          </div>

          {/* Trust and privacy footer */}
          <div className="flex items-center gap-3.5 text-xs text-slate-400 pt-2 select-none">
            <span className="flex items-center gap-1">🔒 Private & Secure</span>
            <span className="w-1.5 h-1.5 rounded-full bg-slate-200" />
            <span>100% Owned Data</span>
          </div>
        </div>

        {/* Hero Right Content: Dashboard Mockup */}
        <div className="relative group transition-all duration-500 hover:scale-[1.01]">
          {/* Subtle Ambient Glow behind mock dashboard */}
          <div className="absolute -inset-10 rounded-[40px] blur-3xl -z-10 bg-gradient-to-br from-indigo-500/10 via-purple-500/5 to-transparent opacity-80" />
          <DashboardMock />
        </div>

      </section>

      {/* ── DYNAMIC BENTO GRID FEATURES ── */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-20 border-t border-slate-100 bg-white/50 backdrop-blur-md">
        <div className="text-center max-w-xl mx-auto mb-16 space-y-3">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-600 border border-indigo-100">
            Platform Capabilities
          </div>
          <h2 className="text-3xl font-black text-slate-800 tracking-tight">Built for data-driven optimization</h2>
          <p className="text-slate-500 text-sm">Everything you need to track, evaluate, and scale your organic visibility.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-6 gap-6">
          
          {/* Card 1: Real-time Performance (Col Span 3) */}
          <div className="md:col-span-3 card bg-white border border-slate-100 rounded-3xl p-6 flex flex-col justify-between shadow-sm hover:shadow-md hover:border-indigo-200 transition duration-300">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="w-10 h-10 rounded-2xl bg-indigo-50 flex items-center justify-center text-indigo-600 text-lg">📈</div>
                <span className="text-[10px] font-bold text-slate-400 bg-slate-50 px-2 py-0.5 rounded-md">Console Data</span>
              </div>
              <div>
                <h3 className="font-bold text-slate-800 text-lg">Real-time Performance</h3>
                <p className="text-xs text-slate-500 mt-1 max-w-md leading-relaxed">
                  Track clicks, impressions, CTR, and average position daily. Observe live search fluctuations and visitor counts.
                </p>
              </div>
            </div>
            
            {/* Visual: Mock Line Chart */}
            <div className="mt-6 bg-slate-50/50 border border-slate-100 rounded-2xl p-4">
              <div className="flex justify-between items-center text-[10px] text-slate-400 mb-2">
                <span>Performance Trend</span>
                <span className="text-emerald-500 font-semibold">+18.5% YoY</span>
              </div>
              <svg viewBox="0 0 300 48" className="w-full text-indigo-500 opacity-90" stroke="currentColor" fill="none" strokeWidth="2.5">
                <path d="M0 40 Q 30 20, 60 30 T 120 10 T 180 35 T 240 15 T 300 5" strokeLinecap="round" />
              </svg>
            </div>
            
            <Link to="/overview" className="inline-flex items-center gap-1 mt-6 text-xs font-bold text-indigo-600 hover:text-indigo-700">
              Explore Overview <span>→</span>
            </Link>
          </div>

          {/* Card 2: AI-Powered Insights (Col Span 3) */}
          <div className="md:col-span-3 card bg-white border border-slate-100 rounded-3xl p-6 flex flex-col justify-between shadow-sm hover:shadow-md hover:border-purple-200 transition duration-300">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="w-10 h-10 rounded-2xl bg-purple-50 flex items-center justify-center text-purple-600 text-lg">✨</div>
                <span className="text-[10px] font-bold text-slate-400 bg-slate-50 px-2 py-0.5 rounded-md">AI Agent</span>
              </div>
              <div>
                <h3 className="font-bold text-slate-800 text-lg">AI-Powered Insights</h3>
                <p className="text-xs text-slate-500 mt-1 max-w-md leading-relaxed">
                  Get smart recommendations to grow your organic traffic. Claude reads your search logs to write a summary briefing every morning.
                </p>
              </div>
            </div>
            
            {/* Visual: Mock Dialogue Briefing */}
            <div className="mt-6 bg-slate-50/50 border border-slate-100 rounded-2xl p-4 space-y-2">
              <div className="text-[9px] text-slate-400 uppercase font-bold tracking-wider">Claude's Analysis snippet</div>
              <div className="text-xs bg-white border border-slate-100 p-2.5 rounded-xl text-slate-600 leading-normal italic relative">
                "Clicks are up 12% driven by a rank shift for 'travel agency' keyword. Consider optimizing CTR."
                <div className="absolute right-3 bottom-1.5 text-[10px] opacity-20">🤖</div>
              </div>
            </div>

            <Link to="/overview" className="inline-flex items-center gap-1 mt-6 text-xs font-bold text-purple-600 hover:text-purple-700">
              Explore AI Insights <span>→</span>
            </Link>
          </div>

          {/* Card 3: Keyword Insights (Col Span 2) */}
          <div className="md:col-span-2 card bg-white border border-slate-100 rounded-3xl p-6 flex flex-col justify-between shadow-sm hover:shadow-md hover:border-amber-200 transition duration-300">
            <div className="space-y-4">
              <div className="w-10 h-10 rounded-2xl bg-amber-50 flex items-center justify-center text-amber-600 text-lg">🔑</div>
              <div>
                <h3 className="font-bold text-slate-800 text-sm">Keyword Insights</h3>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  Monitor keyword rankings and discover high-visibility terms.
                </p>
              </div>
            </div>
            
            {/* Visual: Keyword list */}
            <div className="mt-4 space-y-1.5 bg-slate-50/50 border border-slate-100 rounded-2xl p-3">
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-slate-600 font-medium">1. travel agency</span>
                <span className="text-emerald-600 font-bold">#2 (+4)</span>
              </div>
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-slate-600 font-medium">2. holiday packages</span>
                <span className="text-emerald-600 font-bold">#4 (+8)</span>
              </div>
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-slate-600 font-medium">3. flight booking</span>
                <span className="text-slate-400 font-bold">#14 (0)</span>
              </div>
            </div>

            <Link to="/insights" className="inline-flex items-center gap-1 mt-6 text-xs font-bold text-amber-600 hover:text-amber-700">
              Explore Keywords <span>→</span>
            </Link>
          </div>

          {/* Card 4: Countries & Devices (Col Span 2) */}
          <div className="md:col-span-2 card bg-white border border-slate-100 rounded-3xl p-6 flex flex-col justify-between shadow-sm hover:shadow-md hover:border-sky-200 transition duration-300">
            <div className="space-y-4">
              <div className="w-10 h-10 rounded-2xl bg-sky-50 flex items-center justify-center text-sky-600 text-lg">🌐</div>
              <div>
                <h3 className="font-bold text-slate-800 text-sm">Countries & Devices</h3>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  Understand your global audience and how they read your site content.
                </p>
              </div>
            </div>
            
            {/* Visual: Device / Country indicators */}
            <div className="mt-4 flex gap-2.5 bg-slate-50/50 border border-slate-100 rounded-2xl p-3 justify-around items-center">
              <div className="text-center">
                <div className="text-[10px] text-slate-400">Mobile</div>
                <div className="text-xs font-bold text-slate-700">58%</div>
              </div>
              <div className="w-px h-6 bg-slate-200" />
              <div className="text-center">
                <div className="text-[10px] text-slate-400">Desktop</div>
                <div className="text-xs font-bold text-slate-700">24%</div>
              </div>
              <div className="w-px h-6 bg-slate-200" />
              <div className="text-center">
                <div className="text-[10px] text-slate-400">Top flag</div>
                <div className="text-xs font-bold text-slate-700">🇺🇸 US</div>
              </div>
            </div>

            <Link to="/insights" className="inline-flex items-center gap-1 mt-6 text-xs font-bold text-sky-600 hover:text-sky-700">
              Explore Demographics <span>→</span>
            </Link>
          </div>

          {/* Card 5: Automated Reports (Col Span 2) */}
          <div className="md:col-span-2 card bg-white border border-slate-100 rounded-3xl p-6 flex flex-col justify-between shadow-sm hover:shadow-md hover:border-pink-200 transition duration-300">
            <div className="space-y-4">
              <div className="w-10 h-10 rounded-2xl bg-pink-50 flex items-center justify-center text-pink-600 text-lg">📄</div>
              <div>
                <h3 className="font-bold text-slate-800 text-sm">Automated Reports</h3>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  Weekly and monthly reports compiled and saved automatically.
                </p>
              </div>
            </div>
            
            {/* Visual: Checklist */}
            <div className="mt-4 space-y-1.5 bg-slate-50/50 border border-slate-100 rounded-2xl p-3 text-[10px] text-slate-500 font-medium">
              <div className="flex items-center gap-1.5"><span className="text-emerald-500 font-bold">✓</span> Daily summary logs</div>
              <div className="flex items-center gap-1.5"><span className="text-emerald-500 font-bold">✓</span> Weekly Google doc</div>
              <div className="flex items-center gap-1.5"><span className="text-emerald-500 font-bold">✓</span> MoM monthly digest</div>
            </div>

            <Link to="/compare" className="inline-flex items-center gap-1 mt-6 text-xs font-bold text-pink-600 hover:text-pink-700">
              Explore Reports <span>→</span>
            </Link>
          </div>

        </div>
      </section>

      {/* ── PREMIUM BOTTOM CTA SPLIT CARD WITH DOCK IMAGE ── */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 pb-20">
        <div className="bg-gradient-to-br from-slate-900 via-slate-950 to-indigo-950 rounded-3xl overflow-hidden shadow-2xl border border-slate-800 grid lg:grid-cols-2 gap-8 items-center relative">
          
          {/* Inner ambient glows */}
          <div className="absolute -top-32 -left-32 w-80 h-80 rounded-full bg-indigo-500/10 blur-[100px] pointer-events-none" />
          
          {/* Left: Content Column */}
          <div className="p-8 sm:p-12 md:p-16 space-y-6 relative z-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-xs text-white/80 w-fit">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live Workspace Active
            </div>

            <h2 className="text-3xl sm:text-4xl md:text-5xl font-black text-white tracking-tight leading-tight">
              Supercharge your SEO & Marketing with{' '}
              <span className="bg-gradient-to-r from-indigo-300 via-purple-300 to-pink-300 bg-clip-text text-transparent">
                Autonomous Insights.
              </span>
            </h2>

            <p className="text-slate-300 text-sm sm:text-base leading-relaxed">
              Ditch manual reporting. Let our daily ingestion engine pull Search Console and GA4 metrics, run automated Claude summaries, and compile weekly docs—giving you absolute clarity on what drives your conversions.
            </p>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-6 border-t border-slate-800/80 text-[11px] text-slate-400">
              <span className="flex items-center gap-1.5"><span className="text-emerald-400">✓</span> Automated Ingest</span>
              <span className="flex items-center gap-1.5"><span className="text-emerald-400">✓</span> Claude-4.5 Summaries</span>
              <span className="flex items-center gap-1.5"><span className="text-emerald-400">✓</span> Secure Database</span>
            </div>
          </div>

          {/* Right: Image Column with overlay */}
          <div className="relative h-full min-h-[320px] lg:min-h-[480px] overflow-hidden self-stretch">
            {/* Subtle gradient to blend image with the left column on desktop */}
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent lg:bg-gradient-to-r lg:from-slate-950/50 lg:via-transparent lg:to-transparent z-10" />
            <img
              src="/analysists.jpeg"
              alt="Supercharged Analytics Growth"
              className="w-full h-full object-cover object-left-top hover:scale-105 transition-transform duration-700"
            />
          </div>
          
        </div>
      </section>

    </div>
  );
}

function TrustBadge({ icon, title, status }) {
  return (
    <div className="flex items-center gap-2.5 bg-white border border-slate-100 rounded-2xl px-3 py-2.5 shadow-sm hover:shadow-md hover:border-slate-200 transition duration-200 cursor-default select-none">
      <span className="shrink-0 grid place-items-center">{icon}</span>
      <div className="leading-tight min-w-0">
        <div className="text-[10px] font-bold text-slate-700 leading-snug truncate">{title}</div>
        <div className="text-[9px] text-emerald-600 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />{status}
        </div>
      </div>
    </div>
  );
}

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

/* ───────────────────────── DASHBOARD MOCKUP ───────────────────────── */

function DashboardMock() {
  return (
    <div className="relative rounded-[28px] bg-white border border-slate-100 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.06),0_0_1px_rgba(0,0,0,0.1)] overflow-hidden">
      
      {/* macOS style title bar */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100/80 bg-slate-50/50">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#FF5F56] border border-[#E0443E]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#FFBD2E] border border-[#DEA123]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#27C93F] border border-[#1AAB29]" />
        </div>
        <div className="flex items-center gap-1.5">
          <Logo size={18} />
          <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase select-none">Zunkiree Workspace</span>
        </div>
        <span className="text-[10px] font-semibold text-slate-400 bg-slate-100 rounded-md px-2 py-0.5 select-none">Jun 1 – Jun 30, 2026</span>
      </div>

      <div className="flex">
        {/* sidebar */}
        <div className="w-32 shrink-0 border-r border-slate-100/80 py-4 px-2.5 select-none">
          {NAV.map((n, i) => (
            <div key={n.label}
              className={`text-[9px] rounded-lg px-2.5 py-1.5 mb-0.5 font-semibold flex items-center gap-1.5 transition select-none ${
                i === 0 ? 'text-[#6C63FF] bg-[#6C63FF]/8 hover:bg-[#6C63FF]/12' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
              }`}
              style={i === 0 ? { background: 'rgba(108,99,255,0.08)' } : undefined}>
              <span>{n.icon}</span>
              <span className="truncate">{n.label}</span>
            </div>
          ))}
          <div className="text-[8px] text-slate-300 mt-4 px-2.5">Updated 5m ago</div>
        </div>

        {/* main view */}
        <div className="flex-1 p-4 bg-slate-50/30">
          {/* stats */}
          <div className="grid grid-cols-4 gap-2">
            <MiniStat label="Total Clicks" value="24.5K" delta="+12.5%" color="#10b981" />
            <MiniStat label="Impressions" value="1.2M" delta="+8.3%" color="#6C63FF" />
            <MiniStat label="Average CTR" value="2.04%" delta="+0.5%" color="#0ea5e9" />
            <MiniStat label="Avg Position" value="18.6" delta="-1.1" color="#f59e0b" />
          </div>

          {/* chart */}
          <div className="bg-white rounded-2xl border border-slate-100/80 p-3.5 mt-2.5 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-slate-700">Performance Trend</span>
              <span className="text-[9px] text-slate-400 border border-slate-100 rounded-md px-1.5 py-0.5">Last 7d ▾</span>
            </div>
            <PerfChart />
            <div className="flex items-center gap-3.5 mt-2 text-[9px] text-slate-400 select-none">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-0.5 rounded" style={{ background: PURPLE }} /> Clicks</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 border-t border-dashed border-indigo-300" /> Impressions</span>
            </div>
          </div>

          {/* lower grid widgets */}
          <div className="grid grid-cols-2 gap-2 mt-2.5">
            <div className="bg-white rounded-2xl border border-slate-100/80 p-3 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-slate-700">Top Countries</span>
                <span className="text-[9px] text-[#6C63FF] font-semibold">View all</span>
              </div>
              {[['🇺🇸', 'United States', '12.5K'], ['🇮🇳', 'India', '9.4K'], ['🇬🇧', 'UK', '6.1K'], ['🇩🇪', 'Germany', '4.0K'], ['🇨🇦', 'Canada', '3.3K']].map(([fl, c, v]) => (
                <div key={c} className="flex items-center justify-between text-[10px] mb-1">
                  <span className="flex items-center gap-1.5 text-slate-500 truncate"><span>{fl}</span>{c}</span>
                  <span className="font-bold text-slate-700">{v}</span>
                </div>
              ))}
            </div>
            <div className="bg-white rounded-2xl border border-slate-100/80 p-3 shadow-sm flex flex-col justify-between">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-slate-700">Devices</span>
                <span className="text-[9px] text-[#6C63FF] font-semibold">View all</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-16 h-16 rounded-full shrink-0 flex items-center justify-center relative"
                  style={{ background: `conic-gradient(${PURPLE} 0 58%, #0ea5e9 58% 82%, #f59e0b 82% 100%)` }}>
                  <div className="w-8 h-8 rounded-full bg-white absolute" />
                </div>
                <div className="text-[9px] space-y-1 text-slate-500 font-medium">
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
  const good = !delta.startsWith('-') || label === 'Avg Position';
  return (
    <div className="bg-white rounded-xl border border-slate-100/80 p-2 shadow-sm">
      <div className="text-[8px] text-slate-400 font-semibold truncate uppercase tracking-wider">{label}</div>
      <div className="text-sm font-black text-slate-800 leading-tight mt-0.5">{value}</div>
      <div className="flex items-center justify-between mt-1 select-none">
        <span className={`text-[8px] font-bold ${good ? 'text-emerald-600' : 'text-rose-500'}`}>{delta}</span>
        <Spark color={color} />
      </div>
    </div>
  );
}

function Spark({ color }) {
  return (
    <svg width="30" height="10" viewBox="0 0 40 14" fill="none">
      <polyline points="0,11 7,8 14,9 21,4 28,6 35,2 40,5"
        stroke={color} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Leg({ color, t, v }) {
  return (
    <div className="flex items-center gap-1 truncate">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
      <span>{t}</span>
      <span className="text-slate-300 font-bold ml-0.5">{v}</span>
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
        fill="none" stroke="#6C63FF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="0,80 30,74 60,77 90,68 120,72 150,62 180,70 210,58 240,64 270,52 300,60"
        fill="none" stroke="#c7d2fe" strokeWidth="1.8" strokeDasharray="4 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
