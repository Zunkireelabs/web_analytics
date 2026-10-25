import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { api, timeAgo } from '../api.js';
import { STATUS } from '../lib/palette.js';
import Button from './Button.jsx';

const PANEL_WIDTH = 320; // must match the `md:w-80` on the panel below

// In-app notifications — the first (and today, only) subscriber to the
// channel-agnostic event system (server/notifications/). Polls every
// minute rather than websockets — notification-worthy events only happen
// once a day (the daily agent run) or once a week (competitor check), so a
// push channel would be pure overhead for how often this actually changes.
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null); // { items, unread }
  // Desktop-only: the bell's on-screen position (it lives in the top bar,
  // top-right), used to anchor the panel directly below it, right-aligned
  // like a normal dropdown. null on mobile, where the panel instead uses a
  // fixed, viewport-centered fallback position (see the className below) —
  // anchoring under the bell doesn't work there since it sits too close to
  // the right edge for a 320px panel under it.
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
      // Right-aligned under the bell, clamped to stay fully on-screen.
      const left = Math.max(16, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 16));
      const top = rect.bottom + 8;
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
  // to today's behavior: highlight the finding's owning agent on
  // Orchestration (AiGrowth.jsx), same as health-drop (which has no single
  // finding at all).
  const targetFor = (n) => {
    if (n.draft_id) return `/action-center?openDraft=${n.draft_id}`;
    if (n.finding_ids?.length) return `/ai-orchestration?highlight=${encodeURIComponent(n.finding_ids[0])}`;
    if (n.type === 'health-drop') return '/ai-orchestration?highlight=health-score';
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
      <Button variant="ghost" size="sm" icon onClick={() => setOpen((o) => !o)} aria-label="Notifications">
        <Bell size={16} strokeWidth={1.75} />
      </Button>
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-primary text-white text-[10px] font-medium grid place-items-center ring-2 ring-canvas pointer-events-none">
          {unread > 9 ? '9+' : unread}
        </span>
      )}

      {/* Portaled to document.body: `fixed` positioning is supposed to be
          relative to the viewport, but any transformed or filtered ancestor
          (e.g. a page wrapper's fade-up animation, or the mobile sidebar
          drawer's slide transform) becomes the containing block for its `fixed`
          descendants instead of the viewport, silently shifting the panel.
          Rendering into body sidesteps those ancestors entirely.

          Desktop (`anchor` set): positioned directly below the bell, right-
          aligned to it, like a normal dropdown. Mobile (`anchor` null): falls
          back to the fixed, viewport-centered position — the bell is too
          close to the right edge for a 320px panel under it. */}
      {open && createPortal(
        <div ref={panelRef}
          className={`fixed max-h-[70vh] overflow-y-auto bg-white rounded-card z-50 fade-up ${
            anchor ? 'w-80' : 'top-16 inset-x-4 mx-auto max-w-96'
          }`}
          style={{
            boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 30px 60px -20px rgba(0,0,0,.12)',
            ...(anchor ? { top: anchor.top, left: anchor.left } : {}),
          }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border sticky top-0 bg-white">
            <span className="text-sm font-medium text-fg">Notifications</span>
            {unread > 0 && <Button variant="ghost" size="sm" onClick={markAllRead}>Mark all read</Button>}
          </div>
          {!data?.items?.length ? (
            <div className="p-6 text-center text-sm text-faint">Nothing yet — check back after the next analysis.</div>
          ) : (
            <div>
              {data.items.map((n) => (
                <button key={n.id} onClick={() => openNotification(n)}
                  className={`w-full text-left px-4 py-3 border-b border-border last:border-0 flex gap-2.5 hover:bg-[#fafafa] ${n.read_at ? 'opacity-60' : 'bg-primary-tint/40'}`}>
                  <span className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                    style={{ background: n.severity === 'high' ? STATUS.critical.color : STATUS.warning.color }} />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg">{n.title}</p>
                    <p className="text-xs text-text mt-0.5 line-clamp-2">{n.body}</p>
                    <p className="text-[11px] text-faint mt-1">{timeAgo(n.created_at)}</p>
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
