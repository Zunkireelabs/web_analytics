import { Fragment } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronRight, Menu, MessageSquare } from 'lucide-react';
import Button from './Button.jsx';
import NotificationBell from './NotificationBell.jsx';
import { breadcrumbFor } from '../lib/nav.js';

export default function TopBar({ isInternal, isPlatformAdmin, isProduct, agentOpen, onAgent, agentAvailable, onOpenMenu }) {
  const { pathname } = useLocation();
  const crumbs = breadcrumbFor(pathname, { isPlatformAdmin, isProduct });

  return (
    <header className="sticky top-0 z-30 h-12 flex items-center gap-3 px-4 md:px-6 bg-canvas border-b border-border-canvas">
      {/* Sidebar becomes an overlay drawer below md — this is its trigger, not
          reachable any other way on a narrow viewport. */}
      <Button variant="light" className="md:hidden" onClick={onOpenMenu} aria-label="Open menu">
        <Menu size={14} />
        Menu
      </Button>

      {crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex items-center gap-1.5 min-w-0">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1;
              return (
                <Fragment key={c}>
                  <li className={`text-sm truncate ${last ? 'font-medium text-fg' : 'text-faint hidden md:block'}`}
                    aria-current={last ? 'page' : undefined}>
                    {c}
                  </li>
                  {!last && <ChevronRight size={12} className="text-faint shrink-0 hidden md:block" aria-hidden />}
                </Fragment>
              );
            })}
          </ol>
        </nav>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {isInternal && <NotificationBell />}
        {agentAvailable && (
          <Button variant={agentOpen ? 'light' : 'ghost'} onClick={() => onAgent(!agentOpen)} aria-pressed={agentOpen}>
            <MessageSquare size={14} />
            Agent
          </Button>
        )}
      </div>
    </header>
  );
}
