import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { ShieldCheck, Sparkles, Check } from 'lucide-react';

// The OAuth "Connect" consent screen — reached via a 302 from
// server/mcp/oauth-provider.js's authorize() (server/routes/oauth.js's
// mounted SDK handler redirects an unauthenticated browser through <Login>
// first, see the App.jsx redirect-preservation fix, then lands here once
// authed). Renders inside the normal authenticated app shell (Sidebar etc.)
// like every other route — this is still the logged-in user's own session.
//
// Deliberately no permission-tier picker: what this connection will be
// allowed to do is computed entirely server-side (server/mcp/oauth-provider.js
// computeEffectivePermissionLevel, from sites.oauth_max_permission_level) —
// this component only ever displays that result, never lets the user (or a
// malicious query param) choose it.
export default function OAuthAuthorize() {
  const [params] = useSearchParams();
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const codeChallenge = params.get('code_challenge');
  const state = params.get('state');
  const scope = params.get('scope');
  const resource = params.get('resource');

  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    if (!clientId) return;
    api.oauth.authorizeInfo({ client_id: clientId, redirect_uri: redirectUri || '', scope: scope || '' })
      .then(setInfo)
      .catch((e) => setError(e.message || 'Could not load this connection request.'));
  }, [clientId, redirectUri, scope]);

  const decide = async (approved) => {
    setDeciding(true);
    setError(null);
    try {
      const body = { approved, client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, state, scope, resource };
      const { redirectTo } = await api.oauth.decide(body);
      // Hard navigation, not client-side routing — the destination is the
      // connecting AI client's own (cross-origin) callback URL, not a route
      // in this app.
      window.location.href = redirectTo;
    } catch (e) {
      setError(e.message || 'Could not complete this request.');
      setDeciding(false);
    }
  };

  if (!clientId || !redirectUri || !codeChallenge) {
    return (
      <div className="max-w-lg mx-auto mt-16 px-4">
        <div className="bg-white/70 border border-slate-200/50 backdrop-blur-md shadow-sm rounded-2xl p-6 text-center">
          <p className="text-sm font-bold text-slate-800">This connection link is missing required information.</p>
          <p className="text-xs text-slate-500 mt-2">Go back to the AI client and try connecting again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto mt-16 px-4">
      <div className="bg-white/70 border border-slate-200/50 backdrop-blur-md shadow-sm rounded-2xl p-6">
        <div className="flex flex-col items-center text-center mb-5">
          <div className="w-12 h-12 rounded-2xl grid place-items-center shadow-md mb-3" style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
            <ShieldCheck size={22} className="text-white" />
          </div>
          <h1 className="text-sm font-black text-slate-900">Connect to your Zunkiree Analytics account</h1>
        </div>

        {error && (
          <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 mb-4">
            {error}
          </div>
        )}

        {!info && !error ? (
          <p className="text-xs text-slate-400 font-semibold text-center py-6">Loading…</p>
        ) : info ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-700 font-semibold leading-relaxed text-center">
              <span className="font-black text-slate-900">{info.clientName}</span> wants to access{' '}
              <span className="font-black text-slate-900">{info.siteName}</span>'s Zunkiree Analytics.
            </p>

            <div className="bg-slate-50 border border-slate-200/80 rounded-xl px-4 py-3.5">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">This will allow it to:</p>
              <ul className="space-y-1.5">
                {info.capabilities.map((c) => (
                  <li key={c} className="flex items-start gap-2 text-xs font-semibold text-slate-700">
                    <Check size={13} className="shrink-0 mt-0.5 text-emerald-600" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex items-start gap-2 bg-indigo-50/60 border border-indigo-100 rounded-xl px-3.5 py-3 text-[11px] font-semibold text-indigo-900 leading-relaxed">
              <Sparkles size={14} className="shrink-0 mt-0.5" />
              <span>
                Approving sends your analytics data to this AI client — that's inherent to how this connection
                works, not something this app can prevent. Only approve apps you trust with this data.
              </span>
            </div>

            <div className="flex gap-2 pt-1">
              <button type="button" disabled={deciding} onClick={() => decide(true)}
                className="flex-1 text-[10px] font-black uppercase tracking-wider py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20 cursor-pointer"
                style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
                {deciding ? 'Connecting…' : 'Approve'}
              </button>
              <button type="button" disabled={deciding} onClick={() => decide(false)}
                className="flex-1 text-[10px] font-black uppercase tracking-wider py-3 rounded-xl bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition disabled:opacity-60 cursor-pointer">
                Deny
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
