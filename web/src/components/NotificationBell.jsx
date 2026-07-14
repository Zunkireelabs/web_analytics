import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, timeAgo } from '../api.js';

// In-app notifications — the first (and today, only) subscriber to the
// channel-agnostic event system (server/notifications/). Polls every
// minute rather than websockets — notification-worthy events only happen
// once a day (the daily agent run) or once a week (competitor check), so a
// push channel would be pure overhead for how often this actually changes.
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null); // { items, unread }
  const ref = useRef(null);
  const navigate = useNavigate();

  const load = () => api.notifications.list().then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    function onClickOutside(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
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

  // Every notification is about something on Command Center — a specific
  // finding (critical-issue/opportunity, via finding_ids) or, for
  // health-drop (which has no single finding), the Health Score card
  // itself. CommandCenter.jsx reads `?highlight=` and scrolls/rings the
  // matching card (see its data-finding-id wrappers).
  const targetFor = (n) => {
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
        className="relative w-9 h-9 rounded-lg grid place-items-center text-slate-500 hover:bg-slate-100 hover:text-slate-800
                   transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]">
        <span className="text-lg">🔔</span>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold grid place-items-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        // Opens toward the main content, not off the left edge of the
        // narrow sidebar this bell lives in — `right-0` here would anchor
        // the panel's right edge at the bell (near the sidebar's own left
        // edge) and push most of a 384px-wide panel off-screen.
        <div className="absolute left-0 mt-2 w-96 max-h-[70vh] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-slate-100 z-50 fade-up">
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
        </div>
      )}
    </div>
  );
}
