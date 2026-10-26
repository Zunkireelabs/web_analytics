import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Check, ChevronDown, ChevronsUpDown, Plus, Search, Users } from 'lucide-react';
import { api } from '../api.js';
import { siteDomain, siteInitials } from '../lib/nav.js';
import { ROLE_LABELS, canManageWorkspace, plural } from '../lib/workspace.js';
import NewProjectModal from './workspace/NewProjectModal.jsx';
import NewWorkspaceModal from './workspace/NewWorkspaceModal.jsx';

// Workspace -> projects switcher. The card in the sidebar is the active project;
// it opens a popover where each WORKSPACE is a header row (dark tile, bold name,
// role and project count) and its PROJECTS sit indented beneath it on a tree
// line. Only the workspace holding the active project starts open, so the list
// stays short however many workspaces there are; a platform admin also gets a
// search box. The list comes from GET /api/workspaces, which the server scopes to
// the user's own memberships (a platform admin sees all of them), so nothing here
// decides who may see what.
const LIST_SEARCH_THRESHOLD = 6;

export default function WorkspaceSwitcher({ currentSite, siteId, onSwitch }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState(null); // null = not loaded yet
  const [shared, setShared] = useState([]); // projects given to this person one by one, outside any workspace of theirs
  const [opened, setOpened] = useState({}); // workspace id -> expanded by hand
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [addFor, setAddFor] = useState(null); // workspace the Add project modal is open for
  const [newWsOpen, setNewWsOpen] = useState(false);
  const ref = useRef(null);

  const load = () => api.workspaces()
    .then((r) => { setWorkspaces(r.workspaces || []); setShared(r.shared || []); setError(''); })
    .catch(() => setError('Could not load workspaces.'));

  // Load on first open and again on every later open, so a project added or a
  // membership removed since the last look is reflected.
  useEffect(() => { if (open) load(); else setQuery(''); }, [open]);

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

  const showSearch = !!workspaces && (workspaces.some((w) => w.role === 'platform') || workspaces.length > LIST_SEARCH_THRESHOLD);
  const q = query.trim().toLowerCase();

  const visible = useMemo(() => {
    if (!workspaces) return [];
    if (!q) return workspaces;
    return workspaces.filter((w) => w.name.toLowerCase().includes(q) || w.projects.some((p) => p.name.toLowerCase().includes(q)));
  }, [workspaces, q]);

  const visibleShared = useMemo(() => (q ? shared.filter((p) => p.name.toLowerCase().includes(q) || 'shared with you'.includes(q)) : shared), [shared, q]);
  const groupCount = (workspaces?.length || 0) + (shared.length ? 1 : 0);

  const isOpen = (w) => {
    if (q) return true; // a search shows its matches
    if (w.id in opened) return opened[w.id];
    return groupCount === 1 || w.projects.some((p) => p.id === siteId);
  };
  const sharedOpen = q ? true : ('shared' in opened ? opened.shared : groupCount === 1 || shared.some((p) => p.id === siteId));
  const sharedRoles = [...new Set(shared.map((p) => p.role))];

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
        <div role="menu" className="absolute left-0 right-0 top-full mt-1.5 z-50 bg-white rounded-card overflow-hidden text-sm"
          style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 20px 40px -12px rgba(0,0,0,.18)' }}>
          <div className="flex flex-col max-h-[60vh]">
            {workspaces && (showSearch ? (
              <div className="shrink-0 p-2 border-b border-border">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
                  <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" aria-label="Search workspaces and projects" autoFocus
                    className="h-8 w-full pl-8 pr-3 rounded-control bg-white text-[13px] text-fg outline-none" style={{ boxShadow: '0 0 0 1px var(--input)' }} />
                </div>
              </div>
            ) : (
              <div className="shrink-0 px-3 pt-2.5 pb-1 text-[11px] font-medium tracking-[.08em] uppercase text-faint">Your workspaces</div>
            ))}

            <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
              {workspaces === null && !error && <div className="px-3 py-3 text-xs text-faint">Loading…</div>}
              {error && <div className="px-3 py-3 text-xs text-[#b42318]">{error}</div>}
              {workspaces?.length === 0 && shared.length === 0 && !error && <div className="px-3 py-3 text-xs text-faint">No workspaces yet.</div>}
              {workspaces && visible.length === 0 && visibleShared.length === 0 && groupCount > 0 && <div className="px-3 py-3 text-xs text-faint">Nothing matches “{query}”.</div>}
              {visible.map((w, i) => {
                const expanded = isOpen(w);
                const roleText = w.role === 'platform' ? '' : `${ROLE_LABELS[w.role] || ''} · `;
                const projects = q ? w.projects.filter((p) => w.name.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) : w.projects;
                return (
                  <div key={w.id} className={`p-1 ${i > 0 ? 'border-t border-border' : ''}`}>
                    <button type="button" aria-expanded={expanded} onClick={() => setOpened((o) => ({ ...o, [w.id]: !expanded }))}
                      className="w-full flex items-center gap-2 h-9 px-1.5 rounded-control hover:bg-muted text-left">
                      <span className="w-6 h-6 rounded-[7px] bg-fg text-white grid place-items-center shrink-0"><Building2 size={13} aria-hidden /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-semibold text-fg truncate leading-4">{w.name}</span>
                        <span className="block text-[11px] text-faint mt-0.5" style={{ lineHeight: '12px' }}>{roleText}{plural(w.projects.length, 'project', 'projects')}</span>
                      </span>
                      <ChevronDown size={12} className={`text-faint shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} aria-hidden />
                    </button>
                    {expanded && (
                      <div className="pl-2 border-l border-border-2 mt-0.5 mb-1" style={{ marginLeft: 18 }}>
                        {projects.length === 0 && <div className="px-2 py-1.5 text-xs text-faint">No projects yet.</div>}
                        {projects.map((p) => {
                          const active = p.id === siteId;
                          return (
                            <button key={p.id} type="button" role="menuitemradio" aria-checked={active} disabled={busyId !== null} onClick={() => choose(p)}
                              className="w-full flex items-center gap-2 h-[30px] px-2 rounded-control hover:bg-muted text-left text-[13px] text-text disabled:opacity-60">
                              <span className="w-4 h-4 bg-primary text-white text-[8px] font-medium grid place-items-center shrink-0" style={{ borderRadius: 5 }}>{siteInitials(p.name)}</span>
                              <span className={`min-w-0 flex-1 truncate ${active ? 'text-fg font-medium' : ''}`}>{p.name}</span>
                              {active && <Check size={13} className="text-primary shrink-0" aria-hidden />}
                            </button>
                          );
                        })}
                        {canManageWorkspace(w.role) && (
                          <button type="button" role="menuitem" onClick={() => { setOpen(false); setAddFor(w); }}
                            className="w-full flex items-center gap-2 h-[30px] px-2 rounded-control hover:bg-muted text-left text-[13px] text-faint">
                            <span className="w-4 h-4 border border-dashed grid place-items-center shrink-0" style={{ borderRadius: 5, borderColor: 'var(--input)' }}><Plus size={10} aria-hidden /></span>
                            Add project
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {visibleShared.length > 0 && (
                <div className={`p-1 ${visible.length > 0 ? 'border-t border-border' : ''}`}>
                  <button type="button" aria-expanded={sharedOpen} onClick={() => setOpened((o) => ({ ...o, shared: !sharedOpen }))}
                    className="w-full flex items-center gap-2 h-9 px-1.5 rounded-control hover:bg-muted text-left">
                    <span className="w-6 h-6 rounded-[7px] bg-muted text-fg grid place-items-center shrink-0" style={{ boxShadow: 'inset 0 0 0 1px var(--border-2)' }}><Users size={13} aria-hidden /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold text-fg truncate leading-4">Shared with you</span>
                      <span className="block text-[11px] text-faint mt-0.5" style={{ lineHeight: '12px' }}>{sharedRoles.length === 1 ? `${ROLE_LABELS[sharedRoles[0]]} · ` : ''}{plural(shared.length, 'project', 'projects')}</span>
                    </span>
                    <ChevronDown size={12} className={`text-faint shrink-0 transition-transform ${sharedOpen ? '' : '-rotate-90'}`} aria-hidden />
                  </button>
                  {sharedOpen && (
                    <div className="pl-2 border-l border-border-2 mt-0.5 mb-1" style={{ marginLeft: 18 }}>
                      {visibleShared.map((p) => {
                        const active = p.id === siteId;
                        return (
                          <button key={p.id} type="button" role="menuitemradio" aria-checked={active} disabled={busyId !== null} onClick={() => choose(p)}
                            className="w-full flex items-center gap-2 h-[30px] px-2 rounded-control hover:bg-muted text-left text-[13px] text-text disabled:opacity-60">
                            <span className="w-4 h-4 bg-primary text-white text-[8px] font-medium grid place-items-center shrink-0" style={{ borderRadius: 5 }}>{siteInitials(p.name)}</span>
                            <span className={`min-w-0 flex-1 truncate ${active ? 'text-fg font-medium' : ''}`}>{p.name}</span>
                            {sharedRoles.length > 1 && <span className="text-[11px] text-faint shrink-0">{ROLE_LABELS[p.role]}</span>}
                            {active && <Check size={13} className="text-primary shrink-0" aria-hidden />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-border p-1">
              <button type="button" role="menuitem" onClick={() => { setOpen(false); setNewWsOpen(true); }}
                className="w-full flex items-center gap-2 h-9 px-1.5 rounded-control hover:bg-muted text-left text-[13px] font-medium text-fg">
                <span className="w-6 h-6 border border-dashed grid place-items-center shrink-0 text-faint" style={{ borderRadius: 7, borderColor: 'var(--input)' }}><Plus size={13} aria-hidden /></span>
                New workspace
              </button>
            </div>
          </div>
        </div>
      )}

      {addFor && (
        <NewProjectModal workspace={addFor} isOpen onClose={() => setAddFor(null)}
          onChanged={() => load()}
          onOpenProject={async (project) => { if (project) await onSwitch(project.id); }} />
      )}
      {newWsOpen && <NewWorkspaceModal isOpen onClose={() => setNewWsOpen(false)} onCreated={() => load()} />}
    </div>
  );
}
