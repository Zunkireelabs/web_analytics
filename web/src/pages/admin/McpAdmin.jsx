import { useEffect, useState } from 'react';
import { api, timeAgo } from '../../api.js';
import PageHeader from '../../components/PageHeader.jsx';
import { KeyRound, Ban } from 'lucide-react';

// Kept in sync by hand with server/mcp/permissions.js's PERMISSION_LEVELS,
// same as McpTokensCard.jsx's own TIERS list.
const TIER_LABELS = { read_only: 'Read Only', ai_actions: 'AI Actions', automation: 'Automation', admin: 'Admin' };

export default function McpAdmin() {
  const [tokens, setTokens] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [revoking, setRevoking] = useState({}); // {[id]: true}

  const load = () => api.mcpAdmin.list().then(setTokens).catch((e) => setError(e.message || 'Could not load tokens.'));

  useEffect(() => { load(); }, []);

  const revoke = async (token) => {
    if (!confirm(`Revoke this token for ${token.site_name}? Any client using it will immediately lose access.`)) return;
    setRevoking((s) => ({ ...s, [token.id]: true }));
    try {
      await api.mcpAdmin.revoke(token.id);
      await load();
    } catch (err) {
      setError(err.message || 'Could not revoke token.');
    } finally {
      setRevoking((s) => ({ ...s, [token.id]: false }));
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <PageHeader
        title="MCP Tokens"
        icon="🔑"
        subtitle="Cross-tenant view of every self-serve API token — metadata only, never a raw token value."
      />

      {error && (
        <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{error}</div>
      )}

      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6">
        {tokens === null ? (
          <div className="p-8 text-center text-xs text-slate-400 animate-pulse">Loading tokens…</div>
        ) : tokens.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 italic">No tokens issued yet, across any tenant.</div>
        ) : (
          <div className="divide-y divide-slate-100/70">
            {tokens.map((t) => (
              <div key={t.id} className="py-3.5 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-black text-slate-900 truncate flex items-center gap-2 flex-wrap">
                    <KeyRound size={12} className="text-[#6C63FF] shrink-0" />
                    {t.label || 'Unnamed token'}
                    <span className="font-mono font-medium text-slate-400 text-[11px]">{t.token_prefix}••••••</span>
                    <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500">
                      {TIER_LABELS[t.permission_level] || t.permission_level}
                    </span>
                    {t.revoked_at && (
                      <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-rose-50 text-rose-600">Revoked</span>
                    )}
                  </p>
                  <p className="text-[10px] font-semibold text-slate-400 mt-0.5">
                    {t.site_name} · {t.last_used_at ? `Last used ${timeAgo(t.last_used_at)}` : 'Never used'} · Created {timeAgo(t.created_at)}
                  </p>
                </div>
                {!t.revoked_at && (
                  <button type="button" onClick={() => revoke(t)} disabled={!!revoking[t.id]}
                    className="shrink-0 text-slate-400 hover:text-rose-600 transition p-1.5 disabled:opacity-60" title="Revoke token">
                    <Ban size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
