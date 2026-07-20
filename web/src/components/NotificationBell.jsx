import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api, timeAgo } from '../api.js';

const PANEL_WIDTH = 320; // must match the `md:w-80` on the panel below

// In-app notifications — the first (and today, only) subscriber to the
// channel-agnostic event system (server/notifications/). Polls every
// minute rather than websockets — notification-worthy events only happen
// once a day (the daily agent run) or once a week (competitor check), so a
// push channel would be pure overhead for how often this actually changes.
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null); // { items, unread }
  // Desktop-only: the bell's on-screen position, used to anchor the panel
  // directly below it like a normal dropdown. null on mobile, where the
  // panel instead uses a fixed, viewport-centered fallback position (see
  // the className below) — anchoring under the bell doesn't work there
  // since the bell sits inside a 240px-wide sidebar drawer, far too narrow
  // for a readable panel underneath it.
  const [anchor, setAnchor] = useState(null);
  const ref = useRef(null);
  const panelRef = useRef(null); // the portaled panel lives outside `ref`'s subtree
  const navigate = useNavigate();

  const load = () => api.notifications.list().then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  // Computed with useLayoutEffect (not useEffect) so it's resolved before
  // the browser paints — otherwise the panel would flash at its mobile
  // fallback position for a frame before snapping under the bell.
  useLayoutEffect(() => {
    if (!open) return;
    const mq = window.matchMedia('(min-width: 768px)');
    const compute = () => {
      if (!mq.matches || !ref.current) { setAnchor(null); return; }
      const rect = ref.current.getBoundingClientRect();
      const left = Math.max(16, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 16));
      // The bell sits high up in the sidebar's own header row, well above
      // where the main content's page header (icon + title, ~80px tall on
      // every page via the shared PageHeader component) sits — a small
      // fixed gap below the bell put the panel right on top of that
      // header instead of clearing it. Flooring at 96px from the viewport
      // top (not just below the bell) clears it regardless of exactly how
      // tall the bell's own row is.
      const top = Math.max(rect.bottom + 8, 96);
      setAnchor({ top, left });
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [open]);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const markRead = async (n) => {
    if (n.read_at) return;
    setData((d) => d && {
      unread: Math.max(0, d.unread - 1),
      items: d.items.map((i) => (i.id === n.id ? { ...i, read_at: new Date().toISOString() } : i)),
    });
    await api.notifications.markRead(n.id).catch(() => {});
  };

  const markAllRead = async () => {
    setData((d) => d && { unread: 0, items: d.items.map((i) => ({ ...i, read_at: i.read_at || new Date().toISOString() })) });
    await api.notifications.markAllRead().catch(() => {});
  };

  // "Where the agent decided how to fix it" — if a real draft already
  // exists for this finding (n.draft_id, resolved server-side in
  // store/notifications.js), that decision lives in Action Center, so go
  // straight there with it open. Only findings with a generator ever get a
  // draft (some are structural-only, no generatorId — see
  // agents/ai-visibility.js's RECOMMENDATION_RULES) — for those, fall back
  // to today's behavior: highlight the finding's card on Command Center
  // (which offers a "Generate" action where applicable), same as
  // health-drop (which has no single finding at all).
  const targetFor = (n) => {
    if (n.draft_id) return `/action-center?openDraft=${n.draft_id}`;
    if (n.finding_ids?.length) return `/ai-growth?highlight=${encodeURIComponent(n.finding_ids[0])}`;
    if (n.type === 'health-drop') return '/ai-growth?highlight=health-score';
    return null;
  };

  const openNotification = (n) => {
    markRead(n);
    const target = targetFor(n);
    if (target) { setOpen(false); navigate(target); }
  };

  const unread = data?.unread || 0;

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-label="Notifications"
        className="relative w-10 h-10 rounded-lg grid place-items-center text-slate-500 hover:bg-slate-100 hover:text-slate-800
                   transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]">
        <span className="text-lg">🔔</span>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold grid place-items-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {/* Portaled to document.body: `fixed` positioning is supposed to be
          relative to the viewport, but the mobile sidebar drawer (this
          bell's actual parent) animates open/closed via a CSS `transform`
          (translate-x), and any transformed ancestor becomes the containing
          block for its `fixed` descendants instead of the viewport. That was
          silently shifting this panel left by the drawer's own offset,
          clipping it off-screen. Rendering into body sidesteps that ancestor
          entirely.

          Desktop (`anchor` set): positioned directly below the bell, like a
          normal dropdown. Mobile (`anchor` null): falls back to the fixed,
          viewport-centered position — anchoring under the bell isn't legible
          there, since the bell sits inside a 240px-wide sidebar drawer. */}
      {open && createPortal(
        <div ref={panelRef}
          className={`fixed max-h-[70vh] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-slate-100 z-50 fade-up ${
            anchor ? 'w-80' : 'top-16 left-1/2 -translate-x-1/2 w-[calc(100vw-2rem)] max-w-96'
          }`}
          style={anchor ? { top: anchor.top, left: anchor.left } : undefined}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 sticky top-0 bg-white">
            <span className="text-sm font-bold text-slate-900">Notifications</span>
            {unread > 0 && <button onClick={markAllRead} className="text-[11px] font-semibold text-[#6C63FF] hover:underline">Mark all read</button>}
          </div>
          {!data?.items?.length ? (
            <div className="p-6 text-center text-sm text-slate-400">Nothing yet — check back after the next analysis.</div>
          ) : (
            <div className="divide-y divide-slate-50">
              {data.items.map((n) => (
                <button key={n.id} onClick={() => openNotification(n)}
                  className={`w-full text-left px-4 py-3 flex gap-2.5 transition hover:bg-slate-50 ${n.read_at ? 'opacity-55' : 'bg-[#6C63FF0d]'}`}>
                  <span className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: n.severity === 'high' ? '#e11d48' : '#f59e0b' }} />
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-slate-800">{n.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{n.body}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{timeAgo(n.created_at)}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
