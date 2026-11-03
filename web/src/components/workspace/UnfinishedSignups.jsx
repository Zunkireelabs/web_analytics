import { useEffect, useMemo, useState } from 'react';
import { UserPlus, Send, BellOff } from 'lucide-react';
import { api } from '../../api.js';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import { SummaryRow, FilterBar, BulkBar, Pager, usePaged } from '../platform/ListKit.jsx';
import SettingsCard from '../settings/SettingsCard.jsx';
import SignupProgressDrawer from './SignupProgressDrawer.jsx';
import SignupRemindersModal from './SignupRemindersModal.jsx';
import { FILTERS, SORTS, bulkRemindNote, canRemind, defaultFilter, filterCounts, filterRows, funnelBars, initial, lastActive, reached, reminderStatus, summaryCounts, whyNot } from '../../lib/signup-progress-view.js';

const PER_PAGE = 12;
// The reminder chip: amber for due, green for came back, grey for the rest.
const CHIP = { due: 'bg-[#fff3df] text-[#8a5300]', back: 'bg-green-tint text-green' };
const DOT = { none: 'bg-[#c9c7c3]', soon: 'bg-[#c9c7c3]', sent: 'bg-[#c9c7c3]', due: 'bg-[#e08a00]', back: 'bg-green' };

// Account settings → Platform: everyone who started /get-started, how far they got, what they told us, and the one
// reminder email that brings the ones who stopped back (server/routes/signup-progress.js). Click a row for every answer.
export default function UnfinishedSignups() {
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState(null); // null until the first load picks the pill to open on
  const [sort, setSort] = useState('quiet');
  const [picked, setPicked] = useState(() => new Set()); // row keys ticked for the bulk bar
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null); // the person whose side panel is open
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  const load = () => api.platform.signupProgress.list().then((d) => { setData(d); setError(null); setFilter((f) => f || defaultFilter(d.rows || [])); })
    .catch((e) => setError(e.message || 'Could not load the sign-ups.'));
  useEffect(() => { load(); }, []);

  const rows = data?.rows || [];
  const active = filter || 'all';
  const shown = useMemo(() => filterRows(rows, active, query, sort), [rows, active, query, sort]);
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const summary = summaryCounts(data);
  const { page, setPage, rows: pageRows } = usePaged(shown, PER_PAGE, `${active}|${query}|${sort}`);
  useEffect(() => { setPicked(new Set()); }, [active]);
  const pickable = pageRows.filter(canRemind);
  const chosen = rows.filter((r) => picked.has(rowKey(r)));
  const toggle = (r) => setPicked((p) => { const n = new Set(p); n.has(rowKey(r)) ? n.delete(rowKey(r)) : n.add(rowKey(r)); return n; });
  const allOnPage = pickable.length > 0 && pickable.every((r) => picked.has(rowKey(r)));
  const togglePage = () => setPicked((p) => { const n = new Set(p); pickable.forEach((r) => (allOnPage ? n.delete(rowKey(r)) : n.add(rowKey(r)))); return n; });
  const open = rows.find((r) => rowKey(r) === openId) || null;
  const settings = data?.settings;

  // One action on one person; the result is always said in a note, like the free-trial card does.
  const run = async (key, fn, done) => {
    setBusy(key);
    try { setNote({ text: await fn() || done }); await load(); }
    catch (e) { setNote({ text: e.message || 'That did not work.', bad: true }); }
    finally { setBusy(null); }
  };
  const remind = (r) => run('remind', async () => {
    const out = await api.platform.signupProgress.remind(r.userId);
    return out?.emailed === false ? `The email to ${r.email} could not be sent, so let them know yourself.` : `Reminder sent to ${r.email}. Their link works for ${settings?.linkDays ?? 2} days.`;
  });
  const copyLink = (r) => run('link', async () => {
    const { url } = await api.platform.signupProgress.resumeLink(r.userId);
    try { await navigator.clipboard.writeText(url); return `Resume link for ${r.email} copied. It signs them in and works for ${settings?.linkDays ?? 2} days.`; }
    catch { return `Copy this link for ${r.email}: ${url}`; } // clipboard blocked: show the link instead of losing it
  });
  const mute = (r, muted) => run('mute', async () => {
    await api.platform.signupProgress.mute(r.userId, muted);
    return muted ? `Reminders stopped for ${r.email}.` : `Reminders are back on for ${r.email}.`;
  });

  // Bulk: the same per-person routes, one after another; one note at the end says what happened.
  const bulk = async (kind) => {
    setBusy('bulk'); setNote(null);
    const sent = []; const failed = []; const skipped = [];
    for (const r of chosen) {
      if (!canRemind(r)) { skipped.push({ email: r.email, reason: whyNot(r) }); continue; }
      try {
        if (kind === 'remind') {
          const out = await api.platform.signupProgress.remind(r.userId);
          if (out?.emailed === false) failed.push({ email: r.email, reason: 'email not delivered' }); else sent.push(r.email);
        } else { await api.platform.signupProgress.mute(r.userId, true); sent.push(r.email); }
      } catch (e) { failed.push({ email: r.email, reason: e.message }); }
    }
    const text = kind === 'remind' ? bulkRemindNote({ sent: sent.length, failed, skipped })
      : [`Reminders stopped for ${sent.length} ${sent.length === 1 ? 'person' : 'people'}`, failed.length && `${failed.length} could not be changed: ${failed.map((f) => f.email).join(', ')}`, skipped.length && `${skipped.length} skipped: ${skipped.map((x) => `${x.email} (${x.reason})`).join(', ')}`].filter(Boolean).join(', ') + '.';
    setNote({ text, bad: failed.length > 0 && sent.length === 0 });
    setPicked(new Set());
    await load().catch(() => {});
    setBusy(null);
  };

  const auto = settings && (settings.enabled ? `Reminders: ${settings.remindAfterDays} days` : 'Reminders: off');
  return (
    <>
      <SettingsCard icon={UserPlus} title="Sign-ups in progress" description="People who started Get Started and have not finished.">
        {note && (
          <div className={`mx-4 sm:mx-5 mt-3 rounded-control px-3 py-2 text-[13px] break-words ${note.bad ? 'bg-[#fdecec] text-[#b42318]' : 'bg-green-tint text-green'}`} role="status">{note.text}</div>
        )}
        {error && !data ? (
          <div className="px-4 sm:px-5 py-4 text-[13px] text-[#b42318]" role="alert">
            {error} <button type="button" className="underline underline-offset-2" onClick={load}>Try again</button>
          </div>
        ) : !data ? (
          <p className="px-4 sm:px-5 py-4 text-[13px] text-faint">Loading…</p>
        ) : (
          <>
            <SummaryRow cols={5} counts={[
              { label: 'Started, last 30 days', value: summary.started },
              { label: 'Reminder due', value: summary.due, tone: 'warn', onClick: () => setFilter('due') },
              { label: 'Reminded', value: summary.reminded, onClick: () => setFilter('reminded') },
              { label: 'Email not confirmed', value: summary.unconfirmed, onClick: () => setFilter('unconfirmed') },
              { label: 'Came back after a reminder', value: summary.cameBack },
            ]} />
            <Funnel funnel={data.funnel} />
            <FilterBar query={query} onQuery={setQuery} placeholder="Search email or brand"
              filters={FILTERS.map((f) => ({ ...f, count: counts[f.key] }))} filter={active} onFilter={setFilter}
              sorts={SORTS} sort={sort} onSort={setSort}>
              {settings && (
                <Button size="sm" onClick={() => setSettingsOpen(true)}>
                  <span className={`size-[7px] rounded-full ${settings.enabled ? 'bg-green' : 'bg-[#c9c7c3]'}`} />{auto}
                </Button>
              )}
            </FilterBar>
            <BulkBar count={chosen.length} onClear={() => setPicked(new Set())}>
              <Button variant="primary" size="sm" write disabled={busy === 'bulk'} onClick={() => bulk('remind')}><Send size={13} />{busy === 'bulk' ? 'Working…' : 'Send reminder to selected'}</Button>
              <Button size="sm" write disabled={busy === 'bulk'} onClick={() => bulk('mute')}><BellOff size={13} />Stop reminders</Button>
            </BulkBar>
            {shown.length === 0 ? (
              <p className="px-4 sm:px-5 py-4 border-t border-border text-[13px] text-faint">
                {rows.length === 0 ? 'Nobody has started signing up yet.' : 'No one matches that.'}
              </p>
            ) : (
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full border-collapse sm:min-w-[720px]">
                  <thead>
                    <tr className="text-left text-[12px] font-normal text-faint">
                      <th className="py-3 pl-4 sm:pl-5 pr-1 w-8 border-b border-border">
                        <input type="checkbox" aria-label="Select everyone who can be reminded on this page" checked={allOnPage} disabled={!pickable.length} onChange={togglePage} className="size-4 accent-[var(--primary)]" />
                      </th>
                      <Th>Person</Th><Th>Reached</Th><Th hide>Last active</Th><Th>Reminder</Th><Th last hide="sm"><span className="sr-only">Details</span></Th>
                    </tr>
                  </thead>
                  <tbody>{pageRows.map((r) => <Row key={rowKey(r)} row={r} on={rowKey(r) === openId} ticked={picked.has(rowKey(r))} onTick={() => toggle(r)} onOpen={() => setOpenId(rowKey(r))} />)}</tbody>
                </table>
              </div>
            )}
            <Pager total={shown.length} page={page} per={PER_PAGE} onPage={setPage} noun="people" />
            <p className="px-4 sm:px-5 py-3 border-t border-border text-[12px] text-faint">
              Click a row or Details for every answer. Only people who confirmed their email can be ticked. Real clients never get reminders, and saved answers are cleared after {settings?.keepDays ?? 30} days.
            </p>
          </>
        )}
      </SettingsCard>
      <SignupProgressDrawer row={open} linkDays={settings?.linkDays ?? 2} busy={busy} note={note} onClose={() => setOpenId(null)}
        onRemind={remind} onCopy={copyLink} onMute={mute} />
      {settings && (
        <SignupRemindersModal isOpen={settingsOpen} settings={settings} onClose={() => setSettingsOpen(false)}
          onSaved={() => { setSettingsOpen(false); setNote({ text: 'Reminder settings saved.' }); load(); }} />
      )}
    </>
  );
}

// Someone who never confirmed their email has no user id yet, so the email is what tells two rows apart. (A null id used to match
// "nothing is open", which opened the first such person's panel by itself and left it stuck open.)
const rowKey = (r) => (r.userId != null ? `u${r.userId}` : `e:${r.email}`);

function Th({ last, hide, children }) { // hide: true = below md, 'sm' = below sm
  return <th className={`py-3 pb-2 px-2 sm:px-3 border-b border-border font-normal whitespace-nowrap ${last ? 'pr-4 sm:pr-5' : ''} ${hide === 'sm' ? 'hidden sm:table-cell' : hide ? 'hidden md:table-cell' : ''}`}>{children}</th>;
}

// "How many reach each step": a bar per step; the step that loses the most people is highlighted.
function Funnel({ funnel }) {
  const bars = funnelBars(funnel || []);
  if (!bars.length) return null;
  return (
    <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-border">
      <h3 className="text-[12px] font-medium text-faint mb-2.5">How many reach each step</h3>
      <div className="grid grid-cols-11 gap-1.5 items-end h-[84px]">
        {bars.map((b) => (
          <div key={b.step} className="flex flex-col justify-end h-full min-w-0" title={`${b.name}: ${b.reached}`}>
            <b className={`text-center text-[11px] mb-1 ${b.hot ? 'text-primary font-semibold' : 'text-faint font-medium'}`}>{b.reached}</b>
            <i className={`block rounded-t-md rounded-b-[3px] ${b.hot ? 'bg-primary' : 'bg-[#e7e4df]'}`} style={{ height: b.px }} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-11 gap-1.5 mt-1.5">
        {bars.map((b) => (
          <span key={b.step} className={`text-[10.5px] leading-[13px] text-center truncate ${b.hot ? 'text-primary font-semibold' : 'text-faint max-sm:invisible'}`}>{b.name}</span>
        ))}
      </div>
    </div>
  );
}

function Row({ row, on, ticked, onTick, onOpen }) {
  const r = reached(row);
  const rem = reminderStatus(row);
  const can = canRemind(row);
  return (
    <tr className={`cursor-pointer border-b border-border last:border-0 hover:bg-[#fcfcfb] ${on ? 'bg-primary-tint' : ''}`} onClick={onOpen}>
      <td className="py-3.5 pl-4 sm:pl-5 pr-1 w-8" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={ticked} disabled={!can} onChange={onTick} className="size-4 accent-[var(--primary)] disabled:opacity-30"
          aria-label={can ? `Select ${row.email}` : `${row.email} cannot be reminded`} title={can ? undefined : `Cannot be reminded: ${whyNot(row)}`} />
      </td>
      <td className="py-3.5 px-2 sm:px-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="size-[30px] rounded-[9px] bg-primary-tint text-primary hidden min-[440px]:grid place-items-center text-[12px] font-semibold shrink-0" style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }}>{initial(row)}</span>
          <div className="min-w-0">
            <span className="block text-[13px] font-medium text-fg truncate max-w-[88px] sm:max-w-[260px]">
              {row.email}{row.status === 'client' && <Badge tone="green" className="ml-2 align-[1px]">Real client</Badge>}
            </span>
            <small className="block text-[12px] text-faint truncate max-w-[88px] sm:max-w-[260px]">{row.brand ? `${row.brand} · ${row.website}` : 'No website yet'}</small>
          </div>
        </div>
      </td>
      <td className="py-3.5 px-2 sm:px-3">
        <b className="block text-[13px] font-medium text-fg sm:whitespace-nowrap">{r.name}<small className="ml-1.5 text-[12px] font-normal text-faint">{r.of}</small></b>
        <div className="flex gap-0.5 mt-1.5" aria-hidden="true">{r.dots.map((lit, i) => <i key={i} className={`w-1.5 sm:w-2 h-[3px] rounded-sm ${lit ? 'bg-primary' : 'bg-[#e9e7e4]'}`} />)}</div>
      </td>
      <td className="py-3.5 px-3 hidden md:table-cell text-[13px] text-faint whitespace-nowrap">{lastActive(row.lastActiveAt)}</td>
      <td className="py-3.5 px-2 sm:px-3">
        <span className={`inline-flex items-center gap-[7px] rounded-full px-2 sm:px-2.5 py-1 text-[12px] sm:text-[12.5px] font-medium sm:whitespace-nowrap ${CHIP[rem.tone] || 'bg-muted text-text'}`}>
          <i className={`size-[6px] shrink-0 rounded-full ${DOT[rem.tone]}`} />{rem.text}
        </span>
      </td>
      <td className="hidden sm:table-cell py-3.5 px-2 sm:px-3 pr-4 sm:pr-5 text-right">
        <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(); }} className="h-7 px-2.5 rounded-control bg-white text-[12.5px] font-medium text-fg" style={{ boxShadow: '0 0 0 1px var(--input)' }}>Details</button>
      </td>
    </tr>
  );
}
