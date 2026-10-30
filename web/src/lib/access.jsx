import { createContext, useContext } from 'react';

// Whether the signed-in person can only LOOK at the active project (a workspace or project "member").
// Set once in App.jsx from /me. The server refuses their writes either way; this is so the screens
// say so up front instead of offering buttons that end in an error.
const AccessContext = createContext({ readOnly: false });
export const AccessProvider = AccessContext.Provider;
export const useReadOnly = () => useContext(AccessContext).readOnly;
export const READ_ONLY_HINT = 'You have read-only access to this project.';
