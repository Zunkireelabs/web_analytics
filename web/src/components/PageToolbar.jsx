// Usage: <PageToolbar>…filters…</PageToolbar> anywhere in a page; its children render in the
// shell's toolbar row under the TopBar (the row hides itself when nothing is portaled in).
import { useContext } from 'react';
import { createPortal } from 'react-dom';
import { ShellContext } from './shellContext.js';

export default function PageToolbar({ children }) {
  const toolbarEl = useContext(ShellContext);
  return toolbarEl ? createPortal(children, toolbarEl) : null;
}
