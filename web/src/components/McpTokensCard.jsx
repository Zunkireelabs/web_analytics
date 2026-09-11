import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { KeyRound, Copy, Check, Ban, Info, Lock, Plus, ChevronDown } from 'lucide-react';
import Drawer from './Drawer.jsx';

const labelCls = 'block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5';
const inputCls = 'w-full text-base sm:text-xs border border-slate-200/80 rounded-xl px-3.5 py-2.5 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#6C63FF]/10 focus:border-[#6C63FF] transition duration-150 font-medium text-slate-800 placeholder:text-slate-400';

// Kept in sync by hand with mcp-server/permissions.js's PERMISSION_LEVELS —
// no shared frontend/backend constants module exists in this repo to
// import this from directly.
const TIERS = [
  { value: 'read_only', label: 'Read Only', hint: 'View reports, analytics, and drafts. Cannot change anything.', highTier: false },
  { value: 'ai_actions', label: 'AI Actions', hint: 'Read Only, plus run agents and generate/edit drafts. No GitHub access.', highTier: false },
  { value: 'automation', label: 'Automation', hint: 'AI Actions, plus push branches and open PRs. Never merges automatically — review stays manual.', highTier: true },
  { value: 'admin', label: 'Admin', hint: 'Automation, plus creating and revoking API tokens for this site. An AI client with an Admin token can create more tokens — including more Admin tokens — on its own, with no one confirming each one.', highTier: true },
];

function connectSnippet(token) {
  // POST /api/mcp now lives on its own subdomain (mcp-server/index.js, see
  // the plan: "Split the MCP server onto its own subdomain") — VITE_MCP_ORIGIN
  // is baked in at build time (Dockerfile ARG/ENV). Falls back to this app's
  // own origin if unset, so local dev (npm run dev:web) is unaffected.
  const origin = import.meta.env.VITE_MCP_ORIGIN || (typeof window !== 'undefined' ? window.location.origin : '');
  return `claude mcp add --transport http zunkiree-analytics ${origin}/api/mcp \\\n  --header "Authorization: Bearer ${token}"`;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="shrink-0 text-[10px] font-black uppercase tracking-wider px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 transition flex items-center gap-1.5"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export default function McpTokensCard() {
  const [tokens, setTokens] = useState(null);
  const [error, setError] = useState(null);
  const [label, setLabel] = useState('');
  const [tier, setTier] = useState('read_only');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null); // { token, label } — shown once
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  // Automation/Admin require re-entering the account password first — a
  // speed bump against an accidental high-blast-radius grant, not a hard
  // access-control boundary (the same session can already do this via the
  // API directly). See server/routes/login.js's /verify-password.
  const [confirmingPassword, setConfirmingPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [verifying, setVerifying] = useState(false);

  const load = () => api.mcpTokens.list().then(setTokens).catch((e) => setError(e.message || 'Could not load tokens.'));

  useEffect(() => { load(); }, []);

  const closeDrawer = () => {
    setDrawerOpen(false);
    setJustCreated(null);
    setLabel('');
    setTier('read_only');
    setConfirmingPassword(false);
    setPassword('');
    setError(null);
  };

  const doCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await api.mcpTokens.create(label.trim() || null, tier);
      setJustCreated(created);
      setLabel('');
      setTier('read_only');
      setConfirmingPassword(false);
      setPassword('');
      await load();
    } catch (err) {
      setError(err.message || 'Could not create token.');
    } finally {
      setCreating(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    const selected = TIERS.find((t) => t.value === tier);
    if (selected?.highTier && !confirmingPassword) {
      setError(null);
      setConfirmingPassword(true);
      return;
    }
    doCreate();
  };

  const confirmPasswordAndCreate = async (e) => {
    e.preventDefault();
    setVerifying(true);
    setError(null);
    try {
      await api.verifyPassword(password);
      setPassword('');
      await doCreate();
    } catch (err) {
      setError(err.message || 'Incorrect password.');
    } finally {
      setVerifying(false);
    }
  };

  const revoke = async (id) => {
    if (!confirm('Revoke this token? Any client using it will immediately lose access.')) return;
    try {
      await api.mcpTokens.revoke(id);
      await load();
    } catch (err) {
      setError(err.message || 'Could not revoke token.');
    }
  };

  return (
    <div className="bg-white/70 border border-slate-200/50 backdrop-blur-md shadow-sm rounded-2xl p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h2 className="text-sm font-black text-slate-900 flex items-center gap-2">
          <KeyRound size={15} className="text-[#6C63FF]" /> API Tokens
        </h2>
        <button type="button" onClick={() => setDrawerOpen(true)}
          className="text-[10px] font-black uppercase tracking-wider px-3.5 py-2 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-650 transition flex items-center gap-1.5">
          <Plus size={11} /><span>Create Token</span>
        </button>
      </div>
      <p className="text-xs text-slate-450 font-semibold mb-4">
        Connect Claude, ChatGPT, or any MCP-capable AI client to your analytics.
      </p>

      {error && !drawerOpen && (
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 mb-4">
          {error}
        </div>
      )}

      {!tokens ? (
        <p className="text-xs text-slate-400 font-semibold">Loading…</p>
      ) : tokens.length === 0 ? (
        <p className="text-xs text-slate-400 font-semibold">No tokens yet.</p>
      ) : (
        <div className="space-y-1.5">
          {tokens.map((t) => {
            const tierInfo = TIERS.find((tier) => tier.value === t.permission_level);
            const isOpen = expandedId === t.id;
            return (
              <div key={t.id} className="border border-slate-100 rounded-xl overflow-hidden hover:bg-slate-50/60 hover:shadow-sm transition">
                <div className="w-full flex items-center justify-between gap-3 px-3.5 py-2.5">
                  <button type="button" onClick={() => setExpandedId(isOpen ? null : t.id)}
                    className="min-w-0 flex items-center gap-2 flex-1 text-left">
                    <ChevronDown size={12} className={`text-slate-400 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-800 truncate flex items-center gap-2 flex-wrap">
                        {t.label || 'Unnamed token'}
                        <span className="font-mono font-medium text-slate-400">{t.token_prefix}••••••</span>
                        <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500">
                          {tierInfo?.label || t.permission_level}
                        </span>
                      </p>
                      <p className="text-[10px] font-semibold text-slate-400 mt-0.5">
                        {t.revoked_at ? 'Revoked' : t.last_used_at ? `Last used ${new Date(t.last_used_at).toLocaleDateString()}` : 'Never used'}
                        {' · '}Created {new Date(t.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </button>
                  {!t.revoked_at && (
                    <button type="button" onClick={() => revoke(t.id)}
                      className="shrink-0 text-slate-400 hover:text-rose-600 transition p-1.5" title="Revoke token">
                      <Ban size={14} />
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="px-3.5 pb-3 pt-0.5 border-t border-slate-100 mt-0.5">
                    <p className="text-[11px] font-semibold text-slate-500 leading-relaxed">{tierInfo?.hint}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Drawer isOpen={drawerOpen} onClose={closeDrawer} title="Create API Token" subtitle="Issue a scoped token for an AI client." icon={KeyRound} maxWidth="max-w-lg">
        <div className="flex items-start gap-2 bg-indigo-50/60 border border-indigo-100 rounded-xl px-3.5 py-3 mb-5 text-[11px] font-semibold text-indigo-900 leading-relaxed">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>
            Even a Read Only token sends your analytics data to whichever AI client
            or provider you connect it to — that's inherent to how MCP works, not
            something this app can prevent. Only issue tokens to AI tools you trust
            with this data.
          </span>
        </div>

        {error && (
          <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2 mb-4">
            {error}
          </div>
        )}

        {justCreated ? (
          <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3.5 space-y-2.5">
            <p className="text-[10px] font-black uppercase tracking-widest text-emerald-700">
              Token created — shown once, copy it now
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono text-slate-800 bg-white border border-emerald-200 rounded-lg px-3 py-2 overflow-x-auto whitespace-nowrap">
                {justCreated.token}
              </code>
              <CopyButton text={justCreated.token} />
            </div>
            <p className="text-[10px] font-bold text-emerald-800 uppercase tracking-wide pt-1">Connect with Claude Code</p>
            <div className="flex items-start gap-2">
              <pre className="flex-1 text-[11px] font-mono text-slate-700 bg-white border border-emerald-200 rounded-lg px-3 py-2 overflow-x-auto whitespace-pre">
{connectSnippet(justCreated.token)}
              </pre>
              <CopyButton text={connectSnippet(justCreated.token)} />
            </div>
            <button type="button" onClick={closeDrawer}
              className="w-full text-[10px] font-black uppercase tracking-wider px-4 py-2.5 rounded-xl bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50 transition mt-1">
              Done
            </button>
          </div>
        ) : !confirmingPassword ? (
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className={labelCls}>Label (optional)</span>
              <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Claude Desktop" maxLength={100} />
            </label>

            <div>
              <span className={labelCls}>Permission level</span>
              <div className="space-y-1.5">
                {TIERS.map((t) => (
                  <label key={t.value} className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 cursor-pointer transition ${tier === t.value ? 'border-[#6C63FF] bg-[#6C63FF]/5' : 'border-slate-200/80 hover:border-slate-300'}`}>
                    <input type="radio" name="tier" value={t.value} checked={tier === t.value} onChange={() => setTier(t.value)} className="mt-0.5 accent-[#6C63FF]" />
                    <span>
                      <span className="block text-xs font-bold text-slate-800">{t.label}</span>
                      <span className="block text-[10.5px] font-medium text-slate-500 leading-snug mt-0.5">{t.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <button type="submit" disabled={creating}
              className="w-full text-[10px] font-black uppercase tracking-wider px-5 py-3 rounded-xl text-white transition hover:scale-[1.01] active:scale-[0.98] disabled:opacity-60 shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20"
              style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
              {creating ? 'Creating…' : 'Create Token'}
            </button>
          </form>
        ) : (
          <form onSubmit={confirmPasswordAndCreate} className="space-y-3 bg-amber-50 border border-amber-100 rounded-xl p-4">
            <p className="text-xs font-bold text-amber-900">
              Confirm your password to create a {TIERS.find((t) => t.value === tier)?.label} token
            </p>
            <label className="block">
              <span className={labelCls}>Current password</span>
              <div className="relative">
                <Lock size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input type="password" className={`${inputCls} pl-9`} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Current password" required autoFocus />
              </div>
            </label>
            <div className="flex gap-2">
              <button type="submit" disabled={verifying || creating}
                className="text-[10px] font-black uppercase tracking-wider px-5 py-2.5 rounded-xl text-white transition disabled:opacity-60"
                style={{ background: 'linear-gradient(135deg,#6C63FF,#8b5cf6)' }}>
                {verifying || creating ? 'Confirming…' : 'Confirm & Create'}
              </button>
              <button type="button" onClick={() => { setConfirmingPassword(false); setPassword(''); setError(null); }}
                className="text-[10px] font-black uppercase tracking-wider px-5 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition">
                Cancel
              </button>
            </div>
          </form>
        )}
      </Drawer>
    </div>
  );
}
