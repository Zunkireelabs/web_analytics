import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, MoreHorizontal, Target } from 'lucide-react';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import { siteDomain, siteInitials } from '../../lib/nav.js';
import { ROLE_LABELS, goalLine } from '../../lib/workspace.js';
import { STATUS } from '../../lib/palette.js';

// What is wrong with a project, in a few words, for the card footer.
export function attentionReason(health) {
  const bad = health?.checks?.find((c) => c.state === 'warn');
  if (!bad) return 'Needs attention';
  if (bad.key === 'search_console') return 'Search Console not connected';
  if (bad.key === 'analytics') return 'Analytics not connected';
  return `${bad.label}: ${bad.text.toLowerCase()}`;
}

// A project whose setup was never finished — Google not connected yet, so there
// is no real data behind it. Distinguished from an ordinary "needs attention" so
// the card can offer to finish the job rather than just reporting the symptom.
// A project with no health yet is NOT reported as unfinished: nothing is known.
export function needsSetup(project) {
  const checks = project?.health?.checks;
  if (!Array.isArray(checks)) return false;
  return checks.some((c) => (c.key === 'search_console' || c.key === 'analytics') && c.state === 'warn');
}

// One project on the Workspace page: name and website, its goal in a line, and a
// health footer. Click to open it; the menu has Open and Project settings.
export default function ProjectCard({ project, active, role, shared, onOpen, onSettings, onFinishSetup, onDelete }) {
  const [menu, setMenu] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setMenu(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);
  const attn = project.health?.status === 'attention';
  const unfinished = Boolean(onFinishSetup) && needsSetup(project);

  return (
    <div className="rounded-card bg-white flex flex-col" style={{ boxShadow: 'var(--ring)' }}>
      <div role="button" tabIndex={0} onClick={() => onOpen(project)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(project); }} className="p-4 flex-1 cursor-pointer rounded-t-card">
        <div className="flex items-start gap-2.5">
          <span className="w-8 h-8 rounded-[8px] bg-primary text-white text-[11px] font-medium grid place-items-center shrink-0">{siteInitials(project.name)}</span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-fg truncate">{project.name}</h3>
            <div className="text-xs text-faint truncate">{siteDomain({ website_domain: project.domain }) || 'No website set'}</div>
          </div>
          <div className="relative" ref={ref} onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="sm" icon aria-label={`${project.name} menu`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><MoreHorizontal size={14} /></Button>
            {menu && (
              <div role="menu" className="absolute right-0 top-full mt-1 w-44 bg-white rounded-card p-1 z-20" style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 20px 40px -12px rgba(0,0,0,.18)' }}>
                <button type="button" role="menuitem" className="w-full flex items-center h-8 px-2.5 rounded-control hover:bg-muted text-[13px] text-left" onClick={() => { setMenu(false); onOpen(project); }}>Open</button>
                <button type="button" role="menuitem" className="w-full flex items-center h-8 px-2.5 rounded-control hover:bg-muted text-[13px] text-left" onClick={() => { setMenu(false); onSettings(project); }}>Project settings</button>
                {onDelete && (
                  <button type="button" role="menuitem" className="w-full flex items-center h-8 px-2.5 rounded-control hover:bg-[#fdecec] text-[13px] text-left" style={{ color: '#b42318' }}
                    onClick={() => { setMenu(false); onDelete(project); }}>Delete project</button>
                )}
              </div>
            )}
          </div>
        </div>
        {(shared || active) && (
          <div className="mt-3 flex items-center gap-1.5 flex-wrap">
            {shared && <><Badge tone="primary">{ROLE_LABELS[role]}</Badge><Badge tone="grey">Shared with you</Badge></>}
            {active && <Badge tone="grey">Current</Badge>}
          </div>
        )}
        <div className={`mt-3 text-xs flex items-start gap-1.5 ${project.goal ? 'text-text' : 'text-faint'}`}>
          <Target size={12} className="shrink-0 mt-0.5" />
          <span>{project.goal ? goalLine(project.goal) : 'No goal yet'}</span>
        </div>
      </div>
      <div className="px-4 py-2.5 border-t border-border text-[13px] flex items-center gap-2">
        {unfinished ? (
          <>
            <span className="flex items-center gap-2 min-w-0 flex-1" style={{ color: STATUS.warning.text }}>
              <AlertTriangle size={15} className="shrink-0" /><span className="truncate">Setup not finished</span>
            </span>
            <Button variant="light" size="sm" onClick={() => onFinishSetup(project)}>Finish setting up</Button>
          </>
        ) : !project.health ? <span className="text-faint">Checking…</span>
          : attn ? <span className="flex items-center gap-2 min-w-0" style={{ color: STATUS.warning.text }}><AlertTriangle size={15} className="shrink-0" /><span className="truncate">Needs attention · {attentionReason(project.health)}</span></span>
            : <span className="flex items-center gap-2 text-text"><span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STATUS.good.color }} />Healthy</span>}
      </div>
    </div>
  );
}
