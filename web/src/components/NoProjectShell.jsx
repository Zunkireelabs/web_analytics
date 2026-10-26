import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Settings } from 'lucide-react';
import Button from './Button.jsx';
import { ShellContext } from './shellContext.js';

// What a signed-in person sees before they have a project: a new account that was
// approved from a sign-up request. There is no sidebar to build — every item in it
// is a view of a project — so this is just the SuperRank header, their account
// menu, and the page they can actually use (the Workspace page, where they create
// a workspace and their first project).
//
// It supplies the same ShellContext the full shell does, so the Workspace page's
// toolbar (search, view toggle, New project) renders here unchanged.
export default function NoProjectShell({ email, onLogout, children }) {
  const navigate = useNavigate();
  const [toolbarEl, setToolbarEl] = useState(null);
  return (
    <div className="min-h-screen bg-canvas text-sm">
      <header className="max-w-[1360px] mx-auto px-4 md:px-6 h-14 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[17px] font-semibold tracking-[-0.04em] text-fg">
          <img src="/superrank-logo.png" alt="" width={22} height={22} className="object-contain" />
          <span>super<b className="font-semibold text-primary">rank</b></span>
        </span>
        <div className="flex items-center gap-1 min-w-0">
          {email && <span className="hidden sm:block text-[13px] text-text truncate max-w-[240px] mr-1">{email}</span>}
          <Button variant="ghost" size="sm" onClick={() => navigate('/account')}><Settings size={14} />Account settings</Button>
          <Button variant="ghost" size="sm" onClick={onLogout}><LogOut size={14} />Sign out</Button>
        </div>
      </header>
      <div className="mx-4 md:mx-2 mb-4 bg-white rounded-[14px] overflow-clip md:min-h-[calc(100vh-72px)]" style={{ boxShadow: '0 0 0 1px var(--panel-ring)' }}>
        <ShellContext.Provider value={toolbarEl}>
          <div ref={setToolbarEl} className="page-toolbar flex flex-wrap items-center gap-2 px-4 md:px-6 py-2 bg-white border-b border-border-canvas" />
          <main className="min-w-0">{children}</main>
        </ShellContext.Provider>
      </div>
    </div>
  );
}
