import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CreditCard, MessageSquare, Minus, Sparkles } from 'lucide-react';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import SettingsCard from './SettingsCard.jsx';
import { AUDIENCES, PLANS, fmtNumber, planAction, planPrice, planSaving, planStats, salesMailto } from '../../lib/plans.js';

// Account → Plan & billing. The current plan sits on top with what it includes; "Manage billing" opens the plans
// underneath, inside the same card, so the page keeps its width: one row with the For Brands plans and then the
// For Agencies plans, scrolling left to right inside the box (the edge with more to see fades out), a Monthly /
// Annual switch, and one sales button for the custom plan of the group in view. Customers are already ours, so
// "talk to us" is an email to the team, not the public book-a-demo page. Plan changes are not self-serve yet, so
// the plan buttons open the same email until payments exist.
//
// `current` is { audience, plan, status, label } and comes from Account.jsx, which still has
// it as a placeholder constant (nothing is read from a server yet).
const CARD_W = 264; // px, a plan card
const GAP = 12;     // px, between plan cards

// The detail rows on a plan card. Agency plans show both credit amounts and the annual bonus, so their cards are as
// tall as the brand ones.
const cardStats = (plan) => plan.stats || [
  ['Monthly credits', fmtNumber(plan.credits)],
  ['Credits on annual', fmtNumber(plan.creditsAnnual)],
  ['Annual bonus', `+${fmtNumber(plan.creditsAnnual - plan.credits)}`],
  ['Clients managed', plan.clients],
];

export default function PlanBilling({ current, email, open, onToggle }) {
  const [annual, setAnnual] = useState(false);
  const trackRef = useRef(null);
  const [edge, setEdge] = useState({ left: false, right: true });
  const [inAgencies, setInAgencies] = useState(current.audience === 'agencies');
  const view = PLANS[inAgencies ? 'agencies' : 'brands'];

  // What the current plan includes, shown under its name so the card answers "what am I on?" without opening anything.
  const mine = PLANS[current.audience].plans.find((p) => p.name === current.plan);
  const included = mine ? [['Price', `$${fmtNumber(planPrice(mine, false))} /mo`], ...planStats(mine, false)] : [];

  // Which edges still have plans to scroll to, and which group is in view (it picks the pill and the sales button).
  const measure = useCallback(() => {
    const t = trackRef.current;
    if (!t) return;
    const max = t.scrollWidth - t.clientWidth;
    setEdge({ left: t.scrollLeft > 8, right: t.scrollLeft < max - 8 });
    const agencies = t.querySelector('[data-group="agencies"]');
    setInAgencies(!!agencies && t.scrollLeft + t.clientWidth / 2 > agencies.offsetLeft);
  }, []);

  const jump = useCallback((key, smooth = true) => {
    const t = trackRef.current;
    const g = t?.querySelector(`[data-group="${key}"]`);
    if (!t || !g) return;
    t.scrollTo({ left: Math.max(0, g.offsetLeft - parseFloat(getComputedStyle(t).paddingLeft)), behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Opens on the group the account is in, so its own plan is on screen.
  useEffect(() => {
    if (!open) return undefined;
    jump(current.audience, false);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, current.audience, jump, measure]);

  const step = (dir) => trackRef.current?.scrollBy({ left: dir * (CARD_W + GAP) * 2, behavior: 'smooth' });
  const mailto = (target) => salesMailto({ target, current: { audience: current.audience, plan: current.plan }, email });

  return (
    <SettingsCard icon={CreditCard} title="Plan & billing" description="Your subscription applies to your whole account — every workspace and project.">
      <div className="px-4 sm:px-5 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[13px] text-faint">Current plan</div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[20px] font-medium tracking-[-0.02em] text-fg">{current.label}</span>
            <Badge tone="green">{current.status}</Badge>
          </div>
        </div>
        <Button variant="light" className="max-sm:w-full max-sm:justify-center" aria-expanded={open} aria-controls="plan-billing-panel" onClick={onToggle}>
          Manage billing {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </Button>
      </div>

      {included.length > 0 && (
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 px-4 sm:px-5 py-3.5 border-t border-border">
          {included.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-faint">{label}</dt>
              <dd className="mt-0.5 text-[14px] font-semibold text-fg truncate">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {open && (
        <div id="plan-billing-panel" className="border-t border-border pt-5">
          <div className="px-4 sm:px-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-[18px] leading-6 font-medium tracking-[-0.02em] text-fg">Choose your plan</h3>
              <p className="mt-0.5 text-[13px] text-text">Brands and agencies side by side. Scroll to see them all.</p>
            </div>
            <div className="flex items-center gap-2.5">
              <button type="button" onClick={() => setAnnual(false)} className={`text-[13px] font-medium ${annual ? 'text-faint' : 'text-fg'}`}>Monthly</button>
              <button type="button" role="switch" aria-checked={annual} aria-label="Bill annually" onClick={() => setAnnual((v) => !v)}
                className={`relative w-10 h-[22px] rounded-full shrink-0 transition-colors ${annual ? 'bg-primary' : 'bg-[#d4d2ce]'}`}>
                <span className={`absolute top-[3px] size-4 rounded-full bg-white shadow transition-[left] ${annual ? 'left-[21px]' : 'left-[3px]'}`} />
              </button>
              <button type="button" onClick={() => setAnnual(true)} className={`text-[13px] font-medium ${annual ? 'text-fg' : 'text-faint'}`}>Annual</button>
              <Badge tone="primary">{view.savingPill}</Badge>
              <span className="hidden sm:flex gap-1.5 ml-1">
                <Button variant="light" size="sm" icon aria-label="Scroll plans left" disabled={!edge.left} onClick={() => step(-1)}><ChevronLeft size={14} /></Button>
                <Button variant="light" size="sm" icon aria-label="Scroll plans right" disabled={!edge.right} onClick={() => step(1)}><ChevronRight size={14} /></Button>
              </span>
            </div>
          </div>

          {/* The box: it keeps the card's width; the plans scroll inside it, and the edge with more to see fades out. */}
          <div className="relative mt-1">
            <div ref={trackRef} onScroll={measure} tabIndex={0} aria-label="Plans, scroll sideways"
              className="grid grid-flow-col auto-cols-max overflow-x-auto overflow-y-hidden snap-x snap-proximity px-4 sm:px-5 pt-6 pb-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              style={{ scrollPaddingInline: 20 }}>
              {AUDIENCES.map((a, gi) => {
                const set = PLANS[a.key];
                return (
                  <section key={a.key} data-group={a.key} className={`snap-start flex flex-col ${gi > 0 ? 'ml-5 pl-5 border-l border-dashed border-border-2' : ''}`}>
                    <button type="button" onClick={() => jump(a.key)} className="flex items-baseline gap-2.5 mb-4 text-left">
                      <span className="text-[15px] font-semibold text-fg">{a.label}</span>
                      <span className="text-[13px] text-text whitespace-nowrap">{a.key === 'brands' ? 'Unlimited users. Choose 3 AI models, tracked daily.' : 'Credits shared across all your clients, one bill.'}</span>
                    </button>
                    <div className="flex flex-1" style={{ gap: GAP }}>
                      {set.plans.map((plan) => {
                        const action = planAction(a.key, plan.name, current);
                        const saving = planSaving(plan, annual);
                        const best = !!plan.popular;
                        return (
                          <div key={plan.name} className="tray-card relative p-4 flex flex-col overflow-visible shrink-0" style={{
                            width: CARD_W,
                            ...(action === 'current' ? { boxShadow: '0 0 0 1.5px var(--green)' }
                              : best ? { background: 'linear-gradient(180deg, var(--primary-tint), #fff 38%)', boxShadow: '0 0 0 1.5px var(--primary), 0 18px 34px -22px rgba(213,78,0,.35)' } : {}),
                          }}>
                            {action === 'current' ? (
                              <span className="absolute -top-2.5 left-4 px-2.5 py-[3px] rounded-full bg-green text-white text-[11px] font-semibold">Your plan</span>
                            ) : best && (
                              <span className="absolute -top-2.5 left-4 inline-flex items-center gap-1 px-2.5 py-[3px] rounded-full bg-primary text-white text-[11px] font-semibold">
                                <Sparkles size={11} /> Most popular
                              </span>
                            )}
                            <h4 className="text-sm font-medium text-text">{plan.name}</h4>
                            <div className="mt-1 text-[26px] leading-8 font-semibold tracking-[-0.03em] text-fg">
                              ${fmtNumber(planPrice(plan, annual))}<span className="text-[13px] font-normal tracking-normal text-faint"> /mo</span>
                            </div>
                            <div className="text-xs text-green min-h-4">{saving ? `Save $${fmtNumber(saving)} a year` : annual && plan.creditsAnnual ? '+ bonus credits' : ''}</div>

                            <dl className="mt-2 border-t border-border">
                              {cardStats(plan).map(([label, value]) => (
                                <div key={label} className="flex justify-between gap-2 py-2 text-[13px]">
                                  <dt className="text-text">{label}</dt>
                                  <dd className="font-semibold text-fg text-right">{value}</dd>
                                </div>
                              ))}
                            </dl>

                            <PlanButton action={action} plan={plan.name} best={best} mailto={mailto(plan.name)} />

                            <ul className="mt-3 pt-3 border-t border-border grid gap-2 text-[13px] content-start flex-1">
                              {plan.features.map(([label, included]) => (
                                <li key={label} className={`flex items-center gap-2.5 ${included ? 'text-fg' : 'text-[#b0aeaa]'}`}>
                                  {included ? <Check size={14} className="text-primary shrink-0" /> : <Minus size={14} className="shrink-0" />}
                                  {label}
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
            <div aria-hidden="true" className={`pointer-events-none absolute inset-y-0 left-0 w-20 transition-opacity ${edge.left ? 'opacity-100' : 'opacity-0'}`}
              style={{ background: 'linear-gradient(90deg, #fff 10%, rgba(255,255,255,0))' }} />
            <div aria-hidden="true" className={`pointer-events-none absolute inset-y-0 right-0 w-20 transition-opacity ${edge.right ? 'opacity-100' : 'opacity-0'}`}
              style={{ background: 'linear-gradient(270deg, #fff 10%, rgba(255,255,255,0))' }} />
          </div>

          <div className="mx-4 sm:mx-5 mb-4 flex flex-wrap items-center gap-3 px-4 py-3 rounded-card" style={{ background: 'var(--tray)', boxShadow: 'inset 0 0 0 1px var(--tray-ring)' }}>
            <span className="w-9 h-9 rounded-control bg-white grid place-items-center text-primary shrink-0" style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.05)' }}><MessageSquare size={16} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-fg">{view.custom.name} · Custom</div>
              <div className="text-[13px] text-text">{view.custom.description}</div>
            </div>
            <a className="btn btn--dark max-sm:w-full max-sm:justify-center" href={mailto(view.custom.name)}>{view.custom.cta}</a>
          </div>

          <p className="px-4 sm:px-5 pb-4 text-xs text-faint">Prices in USD. Upgrades are prorated by day; downgrades take effect next billing cycle.</p>
        </div>
      )}
    </SettingsCard>
  );
}

// The most popular plan gets the solid orange button; the others stay light so it stands out.
function PlanButton({ action, plan, best, mailto }) {
  if (action === 'current') return <Button variant="light" className="w-full justify-center mt-1.5" disabled aria-disabled>Current plan</Button>;
  const label = { upgrade: `Upgrade to ${plan}`, downgrade: `Downgrade to ${plan}`, choose: `Choose ${plan}` }[action];
  return <a className={`btn ${best ? 'btn--primary' : 'btn--light'} w-full justify-center mt-1.5`} href={mailto}>{label}</a>;
}
