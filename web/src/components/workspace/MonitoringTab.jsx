import { AlertTriangle, CheckCircle2, Clock, FolderPlus, Key, Mail, Target, UserPlus, Users, Building2, ArrowLeftRight } from 'lucide-react';
import Badge from '../Badge.jsx';
import { Tray, TrayCard } from '../layout/Tray.jsx';
import { timeAgo } from '../../api.js';
import { siteInitials, siteDomain } from '../../lib/nav.js';
import { STATUS } from '../../lib/palette.js';
import { plural } from '../../lib/workspace.js';

const CHECK_ICON = { ok: CheckCircle2, warn: AlertTriangle, pending: Clock };
const CHECK_COLOR = { ok: STATUS.good.color, warn: STATUS.warning.text, pending: STATUS.neutral.color };
const ACTIVITY_ICON = { building: Building2, swap: ArrowLeftRight, folderplus: FolderPlus, target: Target, userplus: UserPlus, mail: Mail, users: Users, key: Key };

// The health of every project in the workspace in plain words, then what changed
// recently. Replaces the old platform-wide Monitoring page for a client's own
// projects: it only ever shows this workspace.
// "Who changed what", from the append-only audit log, in plain sentences.
export function ActivityCard({ activity, email, subtitle = 'Who changed what in this workspace' }) {
  return (
    <TrayCard title="Recent activity" subtitle={subtitle}>
      <div className="border-t border-border">
        {activity.length === 0 ? <div className="px-5 py-6 text-[13px] text-faint">Nothing yet.</div> : activity.map((a) => {
          const Icon = ACTIVITY_ICON[a.icon] || Users;
          const who = a.actorEmail && a.actorEmail === email ? 'You' : (a.actorEmail || 'Someone');
          return (
            <div key={a.id} className="flex items-center gap-3 px-5 py-2.5 border-b border-border last:border-0">
              <span className="w-7 h-7 rounded-full bg-muted text-text grid place-items-center shrink-0"><Icon size={13} /></span>
              <span className="min-w-0 flex-1 text-[13px] text-fg">{who} {a.text}</span>
              <span className="text-xs text-faint shrink-0">{timeAgo(a.createdAt)}</span>
            </div>
          );
        })}
      </div>
    </TrayCard>
  );
}

export default function MonitoringTab({ overview, email }) {
  if (!overview) return <Tray><TrayCard><div className="px-5 py-8"><div className="h-5 bg-muted rounded-control animate-pulse" /></div></TrayCard></Tray>;
  const { projects, needsAttention, activity } = overview;
  const bad = needsAttention > 0;

  return (
    <div>
      <Tray><TrayCard>
        <div className="flex items-center gap-3 px-5 py-4">
          <span className="w-9 h-9 rounded-full grid place-items-center shrink-0" style={{ background: bad ? STATUS.warning.tint : STATUS.good.tint, color: bad ? STATUS.warning.text : STATUS.good.color }}>
            {bad ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-fg">{bad ? `${needsAttention} of ${plural(projects.length, 'project', 'projects')} need${needsAttention === 1 ? 's' : ''} attention` : 'Everything is running normally'}</div>
            <div className="text-xs text-faint mt-0.5">Covers Search Console, Analytics, data freshness and AI agents</div>
          </div>
        </div>
      </TrayCard></Tray>

      {projects.map((p) => {
        const attn = p.health.status === 'attention';
        return (
          <Tray key={p.id} className="mt-3">
            <TrayCard title={<span className="inline-flex items-center gap-2"><span className="w-[22px] h-[22px] rounded-[6px] bg-primary text-white text-[9px] font-medium grid place-items-center">{siteInitials(p.name)}</span>{p.name}</span>}
              subtitle={siteDomain({ website_domain: p.domain })} action={attn ? <Badge tone="amber">Needs attention</Badge> : <Badge tone="green">Healthy</Badge>}>
              <div className="grid grid-cols-1 sm:grid-cols-2 border-t border-border">
                {p.health.checks.map((c, k) => {
                  const Icon = CHECK_ICON[c.state];
                  return (
                    <div key={c.key} className={`flex items-center gap-2.5 px-5 py-3 min-w-0 border-border ${k >= 1 ? 'border-t sm:border-t-0' : ''} ${k % 2 ? 'sm:border-l' : ''} ${k >= 2 ? 'sm:border-t' : ''}`}>
                      <Icon size={16} style={{ color: CHECK_COLOR[c.state] }} className="shrink-0" />
                      <div className="min-w-0"><div className="text-xs text-faint">{c.label}</div><div className="text-[13px] font-medium text-fg truncate">{c.text}</div></div>
                    </div>
                  );
                })}
              </div>
              {attn && !p.health.checks.find((c) => c.key === 'search_console' && c.state === 'ok') && (
                <div className="px-5 py-3 border-t border-border text-[13px] text-text">Connect Search Console and Analytics for this project to start collecting data. Ask your Zunkiree contact to finish the connection.</div>
              )}
            </TrayCard>
          </Tray>
        );
      })}

      <Tray className="mt-3"><ActivityCard activity={activity} email={email} /></Tray>
    </div>
  );
}
