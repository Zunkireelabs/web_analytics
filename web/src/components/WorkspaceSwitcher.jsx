import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { api } from '../api.js';
import { siteDomain, siteInitials } from '../lib/nav.js';
import AddProjectModal from './AddProjectModal.jsx';

// Roles allowed to add projects — mirrors the server's admin floor (the server
// enforces it regardless; this only decides whether the row is shown).
const CAN_ADD_PROJECT = new Set(['owner', 'admin', 'platform']);

// Workspace -> projects switcher. Replaces the plain <select> that used to sit
// over the sidebar's current-site card. The card itself is unchanged; it now
// opens the same ring-shadow popover the user menu uses, listing every
// workspace the signed-in user belongs to with its projects. The list comes
// from GET /api/workspaces, which the server scopes to the user's own
// memberships (a platform admin sees all of them), so nothing here decides
// who may see what.
const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: 'Member' };

export default function WorkspaceSwitcher({ currentSite, siteId, onSwitch }) {
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState(null); // null = not loaded yet
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [addFor, setAddFor] = useState(null); // workspace the Add project modal is open for
  const ref = useRef(null);

  const load = () => api.workspaces()
    .then((r) => { setWorkspaces(r.workspaces || []); setError(''); })
    .catch(() => setError('Could not load workspaces.'));

  // Load on first open and again on every later open, so a project added or a
  // membership removed since the last look is reflected.
  useEffect(() => { if (open) load(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = async (project) => {
    if (project.id === siteId) { setOpen(false); return; }
    setBusyId(project.id);
    setError('');
    try {
      await onSwitch(project.id);
      setOpen(false);
    } catch {
      setError('Could not switch project.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="relative mx-3 mb-2" ref={ref}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="w-full rounded-[10px] bg-white px-2 py-1.5 flex items-center gap-2.5 text-left"
        style={{ boxShadow: 'var(--ring)' }}>
        {currentSite?.logo_data_url ? (
          <img src={currentSite.logo_data_url} alt="" className="w-6 h-6 rounded-[7px] object-contain shrink-0" />
        ) : (
          <span className="w-6 h-6 rounded-[7px] bg-primary text-white text-[10px] font-medium grid place-items-center shrink-0">
            {siteInitials(currentSite?.name)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg truncate">{currentSite?.name || 'No site'}</div>
          <div className="text-xs text-faint truncate">{siteDomain(currentSite)}</div>
        </div>
        <ChevronsUpDown size={14} className="text-faint shrink-0" aria-hidden />
      </button>

      {open && (
        <div role="menu" className="absolute left-0 right-0 top-full mt-1.5 z-50 bg-white rounded-card overflow-hidden text-sm max-h-[60vh] overflow-y-auto"
          style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 20px 40px -12px rgba(0,0,0,.18)' }}>
          {workspaces === null && !error && <div className="px-3 py-3 text-xs text-faint">Loading…</div>}
          {error && <div className="px-3 py-3 text-xs text-[#b42318]">{error}</div>}
          {workspaces?.length === 0 && !error && <div className="px-3 py-3 text-xs text-faint">No workspaces.</div>}
          {workspaces?.map((w, i) => (
            <div key={w.id} className={i > 0 ? 'border-t border-border' : ''}>
              <div className="flex items-baseline justify-between gap-2 px-3 pt-2.5 pb-1 text-[11px] font-medium tracking-[.08em] uppercase text-faint">
                <span className="truncate">{w.name}</span>
                <span className="normal-case tracking-normal font-normal shrink-0">
                  {w.role === 'platform' ? '' : (ROLE_LABELS[w.role] || '')}
                </span>
              </div>
              <div className="p-1 pt-0">
                {w.projects.length === 0 && <div className="px-2.5 py-1.5 text-xs text-faint">No projects yet.</div>}
                {w.projects.map((p) => (
                  <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === siteId}
                    disabled={busyId !== null} onClick={() => choose(p)}
                    className="w-full flex items-center gap-2.5 h-[34px] px-2.5 rounded-control hover:bg-muted text-left disabled:opacity-60">
                    <span className="w-5 h-5 rounded-[6px] bg-primary text-white text-[9px] font-medium grid place-items-center shrink-0">
                      {siteInitials(p.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {p.id === siteId && <Check size={14} className="text-faint shrink-0" aria-hidden />}
                  </button>
                ))}
                {CAN_ADD_PROJECT.has(w.role) && (
                  <button type="button" role="menuitem" onClick={() => { setOpen(false); setAddFor(w); }}
                    className="w-full flex items-center gap-2.5 h-[34px] px-2.5 rounded-control hover:bg-muted text-left text-text">
                    <span className="w-5 h-5 rounded-[6px] border border-dashed border-border grid place-items-center shrink-0 text-faint">
                      <Plus size={12} aria-hidden />
                    </span>
                    Add project
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {addFor && (
        <AddProjectModal workspace={addFor} isOpen onClose={() => setAddFor(null)}
          onCreated={async (project) => {
            setAddFor(null);
            await onSwitch(project.id); // land in the new project straight away
          }} />
      )}
    </div>
  );
}
