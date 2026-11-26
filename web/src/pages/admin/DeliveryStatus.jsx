import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import PageIntro from '../../components/layout/PageIntro.jsx';
import KpiStrip from '../../components/layout/KpiStrip.jsx';
import { Tray, TrayCard } from '../../components/layout/Tray.jsx';
import Badge from '../../components/Badge.jsx';

// Every client's day in one place: how it ended, why, what is stuck, and who merged what. Read only; platform admins only (the server answers 404 to anyone else).
const STATUS_TONE = { delivered: 'green', 'no-work': 'grey', preserved: 'amber', incomplete: 'amber', unreached: 'red', open: 'grey' };
const SEVERITY_TONE = { critical: 'red', high: 'amber', warning: 'grey' };
const LIFECYCLE_LABELS = [
  ['pr_opened', 'PR opened'], ['human_merged', 'Merged by a person'], ['production_verified', 'Verified live'],
  ['merged_by_bot', 'Merged by an app'], ['merged_unattributed', 'Merged (who unknown)'], ['pr_closed', 'Closed unmerged'],
];

const ErrorBanner = ({ children }) => (
  <div className="rounded-control bg-[#fdecec] text-[#b42318] text-[13px] px-3 py-2 mb-3">{children}</div>
);

const Row = ({ children }) => <div className="px-5 py-3 border-t border-border first:border-t-0 text-[13px]">{children}</div>;

function SiteCard({ site }) {
  const t = site.today;
  return (
    <TrayCard
      title={site.name}
      subtitle={t ? `Passes ${t.passes} · attempted ${t.attempted} · shipped ${t.shipped} · blocked ${t.blocked}` : 'No record for today yet'}
      action={<Badge tone={t ? (STATUS_TONE[t.status] || 'grey') : 'red'}>{t ? (t.closed ? t.status : `${t.status} (day not closed)`) : 'no record'}</Badge>}
    >
      {t?.prUrl && <Row>Pull request: <a className="underline" href={t.prUrl} target="_blank" rel="noreferrer">{t.prUrl}</a></Row>}
      {t?.blocker && <Row><span className="text-fg font-medium">Why: </span>{t.blocker}</Row>}
      {t?.recovery && <Row><span className="text-fg font-medium">What happens next: </span>{t.recovery}</Row>}
      {t?.preservedDelivery && (
        <Row>
          <div className="text-fg font-medium mb-1">Preserved delivery (work is safe on branch {t.preservedDelivery.branch})</div>
          <pre className="whitespace-pre-wrap text-[12px] text-text">{t.preservedDelivery.markdown}</pre>
        </Row>
      )}
      {t && t.blockedItems?.length > 0 && (
        <Row>
          <div className="text-fg font-medium mb-1">Blocked items (their content is kept)</div>
          {t.blockedItems.map((b, i) => (
            <div key={i} className="mb-1">
              {b.generator || 'item'}{b.page ? ` · ${b.page}` : ''} — {b.kind || 'unclassified'}{b.retryPolicy ? ` (${b.retryPolicy})` : ''}
              {b.reason ? <span className="text-text"> — {b.reason}</span> : null}
            </div>
          ))}
        </Row>
      )}
      <Row>
        <div className="flex flex-wrap gap-2">
          {LIFECYCLE_LABELS.filter(([k]) => site.lifecycle?.[k] > 0).map(([k, label]) => <Badge key={k} tone={k === 'merged_by_bot' ? 'red' : k === 'production_verified' ? 'green' : 'grey'}>{label}: {site.lifecycle[k]}</Badge>)}
          {LIFECYCLE_LABELS.every(([k]) => !site.lifecycle?.[k]) && <span className="text-text">No pull requests in the last 14 days.</span>}
        </div>
      </Row>
      {site.history?.length > 1 && (
        <Row>
          <span className="text-fg font-medium">Last days: </span>
          {site.history.slice(0, 7).map((h) => `${String(h.date).slice(5, 10)} ${h.status}`).join(' · ')}
        </Row>
      )}
    </TrayCard>
  );
}

export default function DeliveryStatus() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.platform.deliveryStatus().then(setData).catch((e) => setError(e.message || 'Could not load the delivery status.')); }, []);

  const count = (s) => data?.sites.filter((x) => x.today?.status === s).length ?? 0;
  const kpis = data ? [
    { label: 'Delivered (PR open)', value: count('delivered') },
    { label: 'Preserved (PR not open)', value: count('preserved'), delta: count('preserved') ? { text: 'Needs a look', tone: 'bad' } : undefined },
    { label: 'Incomplete', value: count('incomplete') },
    { label: 'No work', value: count('no-work') },
    { label: 'Not reached', value: count('unreached'), delta: count('unreached') ? { text: 'Check why', tone: 'bad' } : undefined },
    { label: 'No record', value: data.sites.filter((x) => !x.today).length, delta: data.sites.some((x) => !x.today) ? { text: 'Should be 0', tone: 'bad' } : undefined },
  ] : [];

  return (
    <>
      <PageIntro title="Delivery status" subtitle={data ? `${data.day} (${data.timezone}). ${data.session?.message || ''}` : 'Every client\'s day: how it ended, why, and what is stuck.'} />
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {!data ? (error ? null : <Tray><TrayCard title="Loading…"><div className="px-5 py-4 text-text text-sm">Reading today's records…</div></TrayCard></Tray>) : (
        <>
          <KpiStrip items={kpis} cols={6} />
          {data.alerts.length > 0 && (
            <Tray className="mt-3">
              <TrayCard title="Alerts" subtitle="Each is stated once a day; critical and high ones are also emailed to staff">
                {data.alerts.map((a) => <Row key={a.key}><Badge tone={SEVERITY_TONE[a.severity] || 'grey'} className="mr-2">{a.severity}</Badge>{a.message}</Row>)}
              </TrayCard>
            </Tray>
          )}
          <Tray className="mt-3" cols={2}>
            {data.sites.map((s) => <SiteCard key={s.siteId} site={s} />)}
          </Tray>
        </>
      )}
    </>
  );
}
