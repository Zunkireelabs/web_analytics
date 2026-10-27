import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDownAZ, Building2, Check, ChevronsUpDown, LayoutGrid, List, Plus, Search, Users } from 'lucide-react';
import { api } from '../api.js';
import Badge from '../components/Badge.jsx';
import Button from '../components/Button.jsx';
import PageToolbar from '../components/PageToolbar.jsx';
import NewProjectModal from '../components/workspace/NewProjectModal.jsx';
import NewWorkspaceModal from '../components/workspace/NewWorkspaceModal.jsx';
import DeleteProjectModal from '../components/workspace/DeleteProjectModal.jsx';
import FirstRunGuide from '../components/workspace/FirstRunGuide.jsx';
import ProjectCard, { attentionReason } from '../components/workspace/ProjectCard.jsx';
import { siteDomain, siteInitials } from '../lib/nav.js';
import { ROLE_LABELS, canManageWorkspace, isWorkspaceOwner, goalLine } from '../lib/workspace.js';

const VIEW_KEY = 'workspace-projects-view';

// The same, for GitHub's screen.
const GITHUB_ERRORS = {
  cancelled: 'You closed the GitHub screen before finishing, so nothing was connected.',
  expired: 'That GitHub sign-in took too long or did not start here. Please try again.',
  denied: 'Your account cannot connect GitHub for this project.',
  exchange_failed: 'GitHub did not accept that sign-in. Please try again.',
  github_failed: 'GitHub could not be reached just now. Please try again.',
};

// What to tell someone who comes back from Google's own screen without a connection.
const GOOGLE_ERRORS = {
  cancelled: 'You closed the Google screen before finishing, so nothing was connected.',
  expired: 'That Google sign-in took too long or did not start here. Please try again.',
  denied: 'Your account cannot connect Google for this project.',
  missing_scopes: 'Search Console and Analytics access both need to be allowed on the Google screen. Please try again and leave both ticked.',
  no_refresh_token: 'Google did not return a long-lived sign-in. Please try again and approve the screen in full.',
  exchange_failed: 'Google did not accept the sign-in. Please try again.',
  not_configured: 'Google sign-in is not set up on this server yet.',
};
const inputRing = { boxShadow: '0 0 0 1px var(--input)' };
const readView = () => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } };

// Sidebar → Workspace: a clean Projects page. The workspace's projects as cards (or a
// list), a search, a status filter and a sort, and New workspace. The workspace name is
// at the top with Switch and New project. Everything else about the workspace and
// its projects (people, API tokens, goals, transfer, health) lives in Account settings.
// Someone who was given access to a single project sees it under "Shared with you".
export default function Workspace({ siteId, onSwitchProject }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [workspaces, setWorkspaces] = useState(null); // null = loading
  const [shared, setShared] = useState([]);
  const [overview, setOverview] = useState(null); // the chosen workspace's projects with goal + health
  const [sharedItems, setSharedItems] = useState({}); // shared project id -> { goal, health }
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('name');
  const [view, setView] = useState(readView);
  const [addOpen, setAddOpen] = useState(false);
  const [resume, setResume] = useState(null); // a project whose setup was left part-way
  const [newWsOpen, setNewWsOpen] = useState(false);
  // Coming back from Google: reopen the New project popup on the Google step for the project that
  // started it, with what happened. `finish` is that project's id; `google`/`gerror` are the outcome.
  const [returning, setReturning] = useState(null); // { google, error } handed to the popup
  const [pageError, setPageError] = useState(null);
  const [deleting, setDeleting] = useState(null); // the project whose delete confirmation is open
  const [pickOpen, setPickOpen] = useState(false);
  const pickRef = useRef(null);

  const load = () => api.workspaces().then((r) => { setWorkspaces(r.workspaces || []); setShared(r.shared || []); }).catch(() => setWorkspaces([]));
  useEffect(() => { load(); }, [siteId]);

  const workspace = workspaces && (workspaces.find((w) => w.id === Number(params.get('ws')))
    || workspaces.find((w) => w.projects.some((p) => p.id === siteId)) || workspaces[0] || null);
  const wsId = workspace?.id;
  const canManage = !!workspace && canManageWorkspace(workspace.role);

  const loadOverview = () => (wsId ? api.workspace.overview(wsId).then(setOverview).catch(() => setOverview({ projects: [] })) : Promise.resolve());
  useEffect(() => { setOverview(null); loadOverview(); }, [wsId]);
  useEffect(() => {
    let live = true;
    Promise.all(shared.map((p) => api.project.overview(p.id).then((r) => [p.id, r.projects?.[0]]).catch(() => [p.id, null])))
      .then((pairs) => { if (live) setSharedItems(Object.fromEntries(pairs)); });
    return () => { live = false; };
  }, [shared.map((p) => p.id).join(',')]);
  useEffect(() => {
    if (!pickOpen) return;
    const onDown = (e) => { if (!pickRef.current?.contains(e.target)) setPickOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickOpen]);
  const chooseView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ } };

  useEffect(() => {
    const finish = Number(params.get('finish')) || null;
    const google = params.get('google');
    const gerror = params.get('gerror') || params.get('gherror');
    const github = params.get('github');
    if (!finish && !gerror) return;
    if (workspaces === null) return; // wait until the projects are known
    const project = finish ? workspaces.flatMap((w) => w.projects).find((p) => p.id === finish) : null;
    const fromGithub = Boolean(github || params.get('gherror'));
    const error = gerror ? (fromGithub ? (GITHUB_ERRORS[gerror] || 'GitHub could not be connected.') : (GOOGLE_ERRORS[gerror] || 'Google could not be connected.')) : null;
    if (project) {
      setReturning({ google, github, error, fromGithub });
      setResume({ id: project.id, name: project.name, domain: project.domain });
      setAddOpen(true);
    } else if (error) setPageError(error);
    setParams((prev) => { const next = new URLSearchParams(prev); ['finish', 'google', 'gerror', 'github', 'gherror'].forEach((k) => next.delete(k)); return next; }, { replace: true });
  }, [workspaces, params]);

  const open = async (project) => { await onSwitchProject(project.id); navigate('/overview'); };
  const settings = (project) => navigate(`/account?scope=project&proj=${project.id}`);

  const shape = (list) => list
    .filter((p) => {
      const q = query.trim().toLowerCase();
      if (q && !(p.name.toLowerCase().includes(q) || (p.domain || '').toLowerCase().includes(q))) return false;
      if (status === 'attention') return p.health?.status === 'attention';
      if (status === 'healthy') return p.health?.status === 'healthy';
      return true;
    })
    .sort((a, b) => (sort === 'attention' ? Number(b.health?.status === 'attention') - Number(a.health?.status === 'attention') : 0) || a.name.localeCompare(b.name));

  const wsProjects = useMemo(() => {
    if (!workspace) return [];
    const byId = new Map((overview?.projects || []).map((p) => [p.id, p]));
    return workspace.projects.map((p) => ({ ...p, goal: byId.get(p.id)?.goal || null, health: byId.get(p.id)?.health || null }));
  }, [workspace, overview]);
  const sharedProjects = useMemo(() => shared.map((p) => ({ ...p, goal: sharedItems[p.id]?.goal || null, health: sharedItems[p.id]?.health || null })), [shared, sharedItems]);

  const shownWs = shape(wsProjects), shownShared = shape(sharedProjects);
  const nothing = workspaces && !workspace && shared.length === 0;
  const sharedRoles = [...new Set(shared.map((p) => p.role))];

  const grid = (list, isShared) => (view === 'list' ? (
    <div className="tray"><div className="tray-card overflow-x-auto">
      <table className="tbl">
        <thead><tr><th>Project</th><th className="hidden md:table-cell">Goal</th><th>Status</th><th className="hidden sm:table-cell">Your access</th><th aria-label="Actions" /></tr></thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id} className="cursor-pointer hover:bg-muted/50" onClick={() => open(p)}>
              <td><div className="flex items-center gap-2.5"><span className="w-7 h-7 rounded-[7px] bg-primary text-white text-[10px] font-medium grid place-items-center shrink-0">{siteInitials(p.name)}</span>
                <div className="min-w-0"><div className="font-medium truncate">{p.name}</div><div className="text-xs text-faint truncate">{siteDomain({ website_domain: p.domain })}</div></div></div></td>
              <td className="hidden md:table-cell text-text">{p.goal ? goalLine(p.goal) : <span className="text-faint">No goal yet</span>}</td>
              <td>{!p.health ? <span className="text-faint text-xs">Checking…</span> : p.health.status === 'attention' ? <Badge tone="amber" title={attentionReason(p.health)}>Needs attention</Badge> : <Badge tone="green">Healthy</Badge>}</td>
              <td className="hidden sm:table-cell"><Badge tone="grey">{ROLE_LABELS[isShared ? p.role : workspace.role] || ''}</Badge></td>
              <td className="num" onClick={(e) => e.stopPropagation()}><Button variant="ghost" size="sm" onClick={() => settings(p)}>Settings</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div></div>
  ) : (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
      {list.map((p) => (
        <ProjectCard key={p.id} project={p} active={p.id === siteId} shared={isShared} role={p.role} onOpen={open} onSettings={settings}
          onFinishSetup={!isShared && canManage ? ((proj) => { setResume(proj); setAddOpen(true); }) : undefined}
          onDelete={!isShared && workspace && isWorkspaceOwner(workspace.role) ? setDeleting : undefined} />
      ))}
      {!isShared && canManage && !query && status === 'all' && (
        <button type="button" onClick={() => { setResume(null); setAddOpen(true); }} className="rounded-card flex flex-col items-center justify-center gap-2 text-[13px] text-faint hover:text-fg"
          style={{ minHeight: 160, border: '1px dashed var(--input)', background: 'transparent' }}>
          <span className="w-8 h-8 rounded-control grid place-items-center" style={{ border: '1px dashed var(--input)' }}><Plus size={16} /></span>New project
        </button>
      )}
    </div>
  ));

  return (
    <div className="max-w-[1360px] mx-auto px-4 md:px-6 pt-6 pb-12 fade-up">
      <PageToolbar>
        <div className="relative basis-full md:basis-auto md:flex-none">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input type="text" placeholder="Search for a project" aria-label="Search for a project" value={query} onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full md:w-56 pl-8 pr-3 rounded-control bg-white text-[13px] text-fg outline-none" style={inputRing} />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" className="h-8 rounded-control bg-white text-[13px] text-fg px-2.5 outline-none" style={inputRing}>
          <option value="all">Status: all</option><option value="healthy">Healthy</option><option value="attention">Needs attention</option>
        </select>
        <div className="relative">
          <ArrowDownAZ size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort projects" className="h-8 rounded-control bg-white text-[13px] text-fg pl-8 pr-2.5 outline-none" style={inputRing}>
            <option value="name">Sorted by name</option><option value="attention">Needs attention first</option>
          </select>
        </div>
        <div className="toggle md:ml-auto" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={view === 'grid'} aria-label="Grid view" className={view === 'grid' ? 'is-on' : undefined} onClick={() => chooseView('grid')} style={{ display: 'grid', placeItems: 'center' }}><LayoutGrid size={15} /></button>
          <button type="button" role="tab" aria-selected={view === 'list'} aria-label="List view" className={view === 'list' ? 'is-on' : undefined} onClick={() => chooseView('list')} style={{ display: 'grid', placeItems: 'center' }}><List size={15} /></button>
        </div>
        <Button variant="primary" onClick={() => setNewWsOpen(true)}><Plus size={14} />New workspace</Button>
      </PageToolbar>

      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="text-[22px] leading-7 md:text-[24px] md:leading-[30px] font-semibold tracking-[-0.025em] text-fg">Projects</h1>
          {workspace ? (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 text-[13px] text-text">
                <span className="w-6 h-6 rounded-[7px] bg-fg text-white grid place-items-center"><Building2 size={13} /></span>
                <b className="font-semibold text-fg">{workspace.name}</b><Badge tone="primary">{ROLE_LABELS[workspace.role]}</Badge>
              </span>
              {workspaces.length > 1 && (
                <div className="relative" ref={pickRef}>
                  <button type="button" onClick={() => setPickOpen((o) => !o)} aria-haspopup="menu" aria-expanded={pickOpen} className="inline-flex items-center gap-1 text-[13px] text-text hover:text-fg"><ChevronsUpDown size={13} className="text-faint" />Switch</button>
                  {pickOpen && (
                    <div role="menu" className="absolute left-0 top-full mt-1.5 z-30 w-64 max-h-[50vh] overflow-y-auto bg-white rounded-card p-1" style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 20px 40px -12px rgba(0,0,0,.18)' }}>
                      {workspaces.map((w) => (
                        <button key={w.id} type="button" role="menuitem" onClick={() => { setPickOpen(false); setParams({ ws: String(w.id) }, { replace: true }); }} className="w-full flex items-center gap-2 h-9 px-2 rounded-control hover:bg-muted text-left">
                          <span className="w-6 h-6 rounded-[7px] bg-fg text-white grid place-items-center shrink-0"><Building2 size={13} /></span>
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{w.name}</span>
                          {w.id === workspace.id && <Check size={14} className="text-faint shrink-0" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : shared.length > 0 ? (
            <div className="mt-2 inline-flex items-center gap-2 text-[13px] text-text">
              <span className="w-6 h-6 rounded-[7px] bg-muted text-fg grid place-items-center" style={{ boxShadow: 'inset 0 0 0 1px var(--border-2)' }}><Users size={13} /></span>
              <b className="font-semibold text-fg">Shared with you</b>{sharedRoles.length === 1 && <Badge tone="primary">{ROLE_LABELS[sharedRoles[0]]}</Badge>}
            </div>
          ) : null}
        </div>
        {canManage && <Button variant="light" onClick={() => { setResume(null); setAddOpen(true); }}><Plus size={14} />New project</Button>}
      </div>

      {workspaces === null ? (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">{[0, 1, 2].map((i) => <div key={i} className="h-40 rounded-card bg-muted animate-pulse" />)}</div>
      ) : nothing ? (
        <FirstRunGuide step={1} actionLabel="Create your workspace" onAction={() => setNewWsOpen(true)} />
      ) : (
        <>
          {workspace && (shownWs.length === 0
            ? (wsProjects.length === 0
              // A workspace with nothing in it yet: the guide, on the step that is next.
              ? <FirstRunGuide step={2} actionLabel="Add your first project" canAct={canManage} onAction={() => { setResume(null); setAddOpen(true); }} />
              : <div className="tray"><div className="tray-card px-5 py-10 text-center text-[13px] text-faint">No projects match your search or filter.</div></div>)
            : grid(shownWs, false))}
          {shared.length > 0 && (
            <div className={workspace ? 'mt-8' : ''}>
              {workspace && <h2 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-fg"><Users size={14} className="text-faint" />Shared with you</h2>}
              {shownShared.length === 0 ? <div className="tray"><div className="tray-card px-5 py-8 text-center text-[13px] text-faint">No shared projects match.</div></div> : grid(shownShared, true)}
            </div>
          )}
        </>
      )}

      {pageError && (
        <div className="rounded-card bg-[#fdecec] text-[#b42318] text-sm px-4 py-3 mb-4 flex items-start justify-between gap-3" role="alert">
          <span>{pageError}</span>
          <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => setPageError(null)}>Dismiss</button>
        </div>
      )}
      {addOpen && workspace && (
        <NewProjectModal workspace={workspace} project={resume} isOpen
          startStep={returning ? (returning.fromGithub ? 4 : 3) : null} notice={returning}
          onClose={() => { setAddOpen(false); setResume(null); setReturning(null); }}
          onChanged={async () => { await Promise.all([load(), loadOverview()]); }}
          onOpenProject={(p) => p && open(p)} />
      )}
      <DeleteProjectModal project={deleting} onClose={() => setDeleting(null)}
        onDeleted={async (project, result) => {
          setDeleting(null);
          // Deleting the project you are looking at changes which one the session is on, so start fresh;
          // otherwise just refresh the lists.
          if (project.id === siteId) { window.location.assign('/workspace'); return; }
          await Promise.all([load(), loadOverview()]);
        }} />
      {newWsOpen && (
        <NewWorkspaceModal isOpen onClose={() => setNewWsOpen(false)}
          onCreated={async (ws) => {
            await load();
            window.dispatchEvent(new Event('workspaces:changed')); // a project-less account becomes a full one (App.jsx)
            if (ws?.id) setParams({ ws: String(ws.id) }, { replace: true });
          }} />
      )}
    </div>
  );
}
