import { createContext, useContext } from 'react';

// Two separate questions about the signed-in person and the active project:
//
//   readOnly  can they only LOOK (a workspace or project "member")? Set once in App.jsx from /me. The server refuses their
//             writes either way; this is so the screens say so up front instead of offering buttons that end in an error.
//   access    the free-trial state of the project (server/store/access.js): 'pending' | 'demo' | 'ended' | 'client' |
//             'rejected', with `locked`, `daysLeft`, `endsAt`, `githubOptional`. null until it has loaded.
const AccessContext = createContext({ readOnly: false, access: null });
export const AccessProvider = AccessContext.Provider;
export const useReadOnly = () => useContext(AccessContext).readOnly;
export const useAccess = () => useContext(AccessContext).access;
export const READ_ONLY_HINT = 'You have read-only access to this project.';

// Where "Start free trial" leads while a project is locked: a person talks to SuperRank first.
export const CONTACT_URL = import.meta.env.VITE_CONTACT_URL || 'https://superrank.si/talk-to-us';

// What a locked project can still open. Everything else shows the lock page. (The server enforces the same idea in
// server/store/access.js; this only decides what the screen draws.)
const OPEN_WHILE_LOCKED = ['/overview', '/account'];
export const isOpenWhileLocked = (pathname) => OPEN_WHILE_LOCKED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
