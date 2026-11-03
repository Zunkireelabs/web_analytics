import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Building2, ChevronRight, LifeBuoy, SlidersHorizontal, Trash2 } from 'lucide-react';
import Badge from '../Badge.jsx';
import SegmentedTabs from '../SegmentedTabs.jsx';
import { FilterBar, Pager, SummaryRow, usePaged } from './ListKit.jsx';
import { AccessBadge, ConnectedCount, ConnectionTiles, ProjectAvatar, RowMenu } from './ListParts.jsx';
import { plural } from '../../lib/workspace.js';
import { siteDomain, siteInitials } from '../../lib/nav.js';
import {
  FILTERS, SORTS, filterCounts, filterWorkspaces, flattenProjects, projectFilterCounts, setupPercent, stateMix, summarize, toSetUp, visibleProjects,
} from '../../lib/workspace-list-view.js';

// Account settings -> Platform -> All workspaces. Workspaces are closed by default with the ones that need attention first;
// a big workspace lists five projects and a "Show N more". A second view lists every project in one table.
// The actions (open as support, controls, transfer, delete) are passed in; this file only draws and filters.

const PROJECTS_SHOWN = 5;
const WORKSPACES_PER_PAGE = 20;
const ROWS_PER_PAGE = 25;

function ProjectMenu({ project, workspace, actions }) {
  return (
    <RowMenu label={`Actions for ${project.name}`} items={[
      { key: 'support', icon: LifeBuoy, label: 'Open as support', hint: 'Look at it as the client sees it. This is logged.', onSelect: () => actions.openSupport(project), disabled: actions.opening === project.id },
      { key: 'controls', icon: SlidersHorizontal, divider: true, label: 'Controls', hint: 'Access, status, autonomous fixes, analytics IDs', onSelect: () => actions.controls(project, workspace) },
      { key: 'transfer', icon: ArrowLeftRight, label: 'Transfer to another workspace', hint: 'Moves its goal, tokens and history', onSelect: () => actions.transfer(project, workspace) },
      { key: 'delete', icon: Trash2, divider: true, danger: true, label: 'Delete project', hint: 'Hides it and stops everything', onSelect: () => actions.controls(project, workspace, 'danger') },
    ]} />
  );
}

const Domain = ({ p }) => <span className="block text-xs text-faint truncate">{siteDomain({ website_domain: p.domain }) || 'No website set'}</span>;

function ProjectRow({ project, workspace, actions }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_170px_70px_124px_32px] items-center gap-x-3 gap-y-2 pl-4 sm:pl-[52px] pr-3 py-3">
      <span className="flex items-center gap-3 min-w-0">
        <ProjectAvatar initials={siteInitials(project.name)} />
        <span className="min-w-0">
          <span className="block text-[13.5px] font-medium text-fg truncate">{project.name}</span>
          <Domain p={project} />
        </span>
      </span>
      <span className="sm:order-last"><ProjectMenu project={project} workspace={workspace} actions={actions} /></span>
      <span className="col-span-2 sm:contents flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-10 sm:pl-0">
        <span><AccessBadge access={project.access} /></span>
        <ConnectedCount project={project} />
        <ConnectionTiles project={project} />
      </span>
    </li>
  );
}

function WorkspaceCard({ w, open, onToggle, showAll, onShowAll, query, actions }) {
  const mix = stateMix(w);
  const setUp = toSetUp(w);
  const pct = setupPercent(w);
  const list = visibleProjects(w, query);
  const shown = showAll ? list : list.slice(0, PROJECTS_SHOWN);
  const owner = w.owners[0];
  return (
    <div className="rounded-card bg-white overflow-hidden" style={{ boxShadow: '0 0 0 1px var(--input)' }}>
      <div className={`flex items-center gap-1 pr-2 bg-[#fafaf9] ${open ? 'border-b border-border' : ''}`}>
        <button type="button" aria-expanded={open} aria-controls={`ws-${w.id}-projects`} onClick={onToggle}
          className="flex-1 min-w-0 flex items-center gap-3 pl-3 pr-2 py-3 text-left">
          <ChevronRight size={15} className={`text-faint shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="w-8 h-8 rounded-[9px] bg-fg text-white grid place-items-center shrink-0"><Building2 size={15} /></span>
          <span className="min-w-0 lg:w-[250px] lg:shrink-0">
            <b className="block text-[14px] font-semibold text-fg truncate">{w.name}</b>
            <span className="block text-xs text-faint truncate">{plural(w.projects.length, 'project', 'projects')} · {plural(w.memberCount, 'person', 'people')}{owner ? ` · ${owner}` : ' · No owner'}</span>
          </span>
          <span className="hidden lg:flex flex-1 items-center gap-1.5 flex-wrap min-w-0">
            {mix.client > 0 && <Badge tone="green" dot>{mix.client} client</Badge>}
            {mix.trial > 0 && <Badge tone="amber" dot>{mix.trial} trial</Badge>}
            {mix.ended > 0 && <Badge tone="red" dot>{mix.ended} ended</Badge>}
            {mix.fresh > 0 && <Badge tone="grey" dot>{mix.fresh} new</Badge>}
            {mix.rejected > 0 && <Badge tone="red" dot>{mix.rejected} declined</Badge>}
          </span>
          <span className="hidden sm:flex items-center gap-3 shrink-0">
            {setUp > 0 ? <Badge tone="amber" dot>{setUp} to set up</Badge> : <Badge tone="green">Set up</Badge>}
            <span className="hidden md:flex items-center gap-2 w-[170px]" title={`${pct}% of the connections are in place`}>
              <span className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden"><span className="block h-full rounded-full" style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--green)' : '#e0a100' }} /></span>
              <span className="text-xs text-faint tnum w-[68px] text-right">{pct}% set up</span>
            </span>
          </span>
        </button>
        <RowMenu label={`Actions for workspace ${w.name}`} items={[
          { key: 'delete', icon: Trash2, danger: true, label: 'Delete workspace', hint: `Removes ${w.name} and its projects`, onSelect: () => actions.deleteWorkspace(w) },
        ]} />
      </div>
      {open && (
        <div id={`ws-${w.id}-projects`}>
          {setUp > 0 && <div className="sm:hidden px-4 pt-2.5"><Badge tone="amber" dot>{setUp} to set up</Badge></div>}
          {list.length === 0
            ? <p className="px-4 py-4 text-[13px] text-faint">No projects in this workspace yet.</p>
            : <ul className="list-none m-0 p-0 divide-y divide-border">{shown.map((p) => <ProjectRow key={p.id} project={p} workspace={w} actions={actions} />)}</ul>}
          {list.length > PROJECTS_SHOWN && (
            <div className="flex flex-wrap items-center gap-x-3 px-4 sm:pl-[52px] py-2.5 text-[13px] text-faint border-t border-border bg-[#fafaf9]">
              <span>Showing {shown.length} of {list.length} projects</span>
              <button type="button" onClick={onShowAll} className="text-primary font-medium hover:underline">{showAll ? 'Show fewer' : `Show ${list.length - PROJECTS_SHOWN} more`}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectTable({ rows, actions }) {
  return (
    <div className="rounded-card bg-white overflow-hidden" style={{ boxShadow: '0 0 0 1px var(--input)' }}>
      <div className="hidden lg:grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_170px_70px_124px_minmax(0,1.2fr)_32px] gap-x-3 px-4 py-2.5 text-xs text-faint bg-[#fafaf9] border-b border-border">
        <span>Project</span><span>Workspace</span><span>Access</span><span>Connected</span><span /><span>Owner</span><span />
      </div>
      <ul className="list-none m-0 p-0 divide-y divide-border">
        {rows.map(({ project, workspace, owner }) => (
          <li key={project.id} className="grid grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_170px_70px_124px_minmax(0,1.2fr)_32px] items-center gap-x-3 gap-y-1.5 px-4 py-3">
            <span className="flex items-center gap-3 min-w-0">
              <ProjectAvatar initials={siteInitials(project.name)} />
              <span className="min-w-0"><span className="block text-[13.5px] font-medium text-fg truncate">{project.name}</span><Domain p={project} /></span>
            </span>
            <span className="lg:order-last"><ProjectMenu project={project} workspace={workspace} actions={actions} /></span>
            <span className="col-span-2 lg:contents flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-10 lg:pl-0">
              <span className="text-[13px] text-text truncate order-first lg:order-none basis-full lg:basis-auto">{workspace.name}</span>
              <span><AccessBadge access={project.access} /></span>
              <ConnectedCount project={project} />
              <ConnectionTiles project={project} />
              <span className="text-[13px] text-faint truncate min-w-0">{owner || 'No owner'}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function WorkspacesView({ workspaces, actions }) {
  const [view, setView] = useState('workspaces');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('attention');
  const [override, setOverride] = useState({}); // workspace id -> true/false once the person has opened or closed it
  const [showAll, setShowAll] = useState({});
  const searching = query.trim() !== '';
  useEffect(() => { setOverride({}); }, [query]);

  const summary = useMemo(() => summarize(workspaces), [workspaces]);
  const wsCounts = useMemo(() => filterCounts(workspaces, query), [workspaces, query]);
  const prCounts = useMemo(() => projectFilterCounts(workspaces, query), [workspaces, query]);
  const counts = view === 'workspaces' ? wsCounts : prCounts;
  const list = useMemo(() => (view === 'workspaces' ? filterWorkspaces(workspaces, { filter, query, sort }) : []), [view, workspaces, filter, query, sort]);
  const rows = useMemo(() => (view === 'projects' ? flattenProjects(workspaces, { filter, query, sort }) : []), [view, workspaces, filter, query, sort]);
  const resetKey = `${view}|${filter}|${query}|${sort}`;
  const wsPage = usePaged(list, WORKSPACES_PER_PAGE, resetKey);
  const rowPage = usePaged(rows, ROWS_PER_PAGE, resetKey);

  const isOpen = (id) => (id in override ? override[id] : searching);
  const anyOpen = wsPage.rows.some((w) => isOpen(w.id));
  const setAll = (v) => setOverride(Object.fromEntries(wsPage.rows.map((w) => [w.id, v])));
  const empty = view === 'workspaces' ? list.length === 0 : rows.length === 0;

  return (
    <>
      <SummaryRow cols={6} counts={[
        { label: 'Workspaces', value: summary.workspaces },
        { label: 'Projects', value: summary.projects },
        { label: 'People', value: summary.people },
        { label: 'Real clients', value: summary.clients },
        { label: 'On a trial', value: summary.trials },
        { label: 'Need attention', value: summary.attention, tone: 'warn', onClick: () => { setFilter('attention'); setView('workspaces'); } },
      ]} />
      <FilterBar query={query} onQuery={setQuery} placeholder="Search workspaces, projects, owners"
        filters={FILTERS.map((f) => ({ ...f, count: counts[f.key] }))} filter={filter} onFilter={setFilter}
        sorts={SORTS} sort={sort} onSort={setSort}>
        {view === 'workspaces' && wsPage.rows.length > 0 && (
          <button type="button" onClick={() => setAll(!anyOpen)} className="text-[13px] font-medium text-primary hover:underline">{anyOpen ? 'Collapse all' : 'Expand all'}</button>
        )}
      </FilterBar>
      <div className="px-4 sm:px-5 pb-3 -mt-1.5">
        <SegmentedTabs options={[{ value: 'workspaces', label: 'Workspaces' }, { value: 'projects', label: 'All projects' }]} value={view} onChange={setView} />
      </div>

      {empty ? (
        <div className="px-5 py-10 text-center text-[13px] text-faint">
          {workspaces.length === 0 ? 'No workspaces yet.' : 'Nothing matches.'}
          {workspaces.length > 0 && <button type="button" className="ml-2 text-primary font-medium hover:underline" onClick={() => { setQuery(''); setFilter('all'); }}>Clear search and filters</button>}
        </div>
      ) : view === 'workspaces' ? (
        <div className="px-4 sm:px-5 pb-3 space-y-2.5">
          {wsPage.rows.map((w) => (
            <WorkspaceCard key={w.id} w={w} open={isOpen(w.id)} onToggle={() => setOverride((o) => ({ ...o, [w.id]: !isOpen(w.id) }))}
              showAll={Boolean(showAll[w.id])} onShowAll={() => setShowAll((s) => ({ ...s, [w.id]: !s[w.id] }))} query={query} actions={actions} />
          ))}
        </div>
      ) : (
        <div className="px-4 sm:px-5 pb-3"><ProjectTable rows={rowPage.rows} actions={actions} /></div>
      )}
      {!empty && (view === 'workspaces'
        ? <Pager total={list.length} page={wsPage.page} per={WORKSPACES_PER_PAGE} onPage={wsPage.setPage} noun="workspaces" />
        : <Pager total={rows.length} page={rowPage.page} per={ROWS_PER_PAGE} onPage={rowPage.setPage} noun="projects" />)}
    </>
  );
}
