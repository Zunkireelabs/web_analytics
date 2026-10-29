import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, CreditCard, Minus } from 'lucide-react';
import Badge from '../Badge.jsx';
import Button from '../Button.jsx';
import SettingsCard from './SettingsCard.jsx';
import { AUDIENCES, PLANS, fmtNumber, planAction, planPrice, planSaving, planStats, salesMailto } from '../../lib/plans.js';

// Account → Plan & billing. The current plan sits on top; "Manage billing" opens the plans
// underneath: For Brands / For Agencies, a Monthly / Annual switch, three plan cards and a
// "talk to us" row for the custom plan. Customers are already ours, so "talk to us" is an
// email to the team, not the public book-a-demo page. Plan changes are not self-serve yet, so
// the plan buttons open the same email until payments exist.
//
// `current` is { audience, plan, status, label } and comes from Account.jsx, which still has
// it as a placeholder constant (nothing is read from a server yet).
export default function PlanBilling({ current, email, open, onToggle }) {
  const [audience, setAudience] = useState(current.audience);
  const [annual, setAnnual] = useState(false);
  const set = PLANS[audience];

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

      {open && (
        <div id="plan-billing-panel" className="border-t border-border px-4 sm:px-5 py-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-[20px] leading-7 font-medium tracking-[-0.02em] text-fg">Choose your plan</h3>
              <p className="mt-1 text-[13px] text-text max-w-[440px]">{set.description}</p>
            </div>
            <div role="group" aria-label="Plans for" className="inline-flex gap-0.5 p-[3px] rounded-control bg-muted">
              {AUDIENCES.map((a) => (
                <button key={a.key} type="button" aria-pressed={audience === a.key} onClick={() => setAudience(a.key)}
                  className={`px-3.5 py-1.5 rounded-[6px] text-[13px] font-medium ${audience === a.key ? 'bg-white text-fg shadow-[var(--ring)]' : 'text-text hover:text-fg'}`}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-[18px] flex md:justify-end items-center gap-2.5">
            <button type="button" onClick={() => setAnnual(false)} className={`text-[13px] font-medium ${annual ? 'text-faint' : 'text-fg'}`}>Monthly</button>
            <button type="button" role="switch" aria-checked={annual} aria-label="Bill annually" onClick={() => setAnnual((v) => !v)}
              className={`relative w-10 h-[22px] rounded-full shrink-0 transition-colors ${annual ? 'bg-primary' : 'bg-[#d4d2ce]'}`}>
              <span className={`absolute top-[3px] size-4 rounded-full bg-white shadow transition-[left] ${annual ? 'left-[21px]' : 'left-[3px]'}`} />
            </button>
            <button type="button" onClick={() => setAnnual(true)} className={`text-[13px] font-medium ${annual ? 'text-fg' : 'text-faint'}`}>Annual</button>
            <Badge tone="primary">{set.savingPill}</Badge>
          </div>

          <div className="mt-3 grid gap-3.5 md:grid-cols-3">
            {set.plans.map((plan) => {
              const action = planAction(audience, plan.name, current);
              const saving = planSaving(plan, annual);
              return (
                <div key={plan.name} className={`tray-card p-5 flex flex-col ${action === 'current' ? '!shadow-[0_0_0_1.5px_var(--primary)]' : ''}`}>
                  <h4 className="flex flex-wrap items-center gap-2 min-h-[22px] text-sm font-medium text-text">
                    {plan.name}
                    {action === 'current' ? <Badge tone="primary">Current</Badge> : plan.popular && <Badge tone="primary">Most popular</Badge>}
                  </h4>
                  <div className="mt-1.5 text-[28px] leading-9 font-semibold tracking-[-0.03em] text-fg">
                    ${fmtNumber(planPrice(plan, annual))}<span className="text-[13px] font-normal tracking-normal text-faint"> /mo</span>
                  </div>
                  <div className="text-xs text-green mt-0.5 min-h-4">{saving ? `Save $${fmtNumber(saving)} a year` : annual && plan.creditsAnnual ? '+ bonus credits' : ''}</div>

                  <dl className="mt-3.5 border-t border-border">
                    {planStats(plan, annual).map(([label, value]) => (
                      <div key={label} className="flex justify-between gap-2 py-2.5 text-[13px]">
                        <dt className="text-text">{label}</dt>
                        <dd className="font-semibold text-fg text-right">{value}</dd>
                      </div>
                    ))}
                  </dl>

                  <PlanButton action={action} plan={plan.name} mailto={salesMailto({ target: plan.name, current: { audience: current.audience, plan: current.plan }, email })} />

                  <ul className="mt-4 pt-4 border-t border-border grid gap-2.5 text-[13px]">
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

          <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 px-5 py-4 rounded-card" style={{ background: 'var(--tray)', boxShadow: 'inset 0 0 0 1px var(--tray-ring)' }}>
            <div>
              <div className="text-sm font-semibold text-fg">{set.custom.name} · Custom</div>
              <div className="text-[13px] text-text">{set.custom.description}</div>
            </div>
            <a className="btn btn--light" href={salesMailto({ target: set.custom.name, current: { audience: current.audience, plan: current.plan }, email })}>{set.custom.cta}</a>
          </div>

          <p className="mt-3.5 text-xs text-faint">Prices in USD. Upgrades are prorated by day; downgrades take effect next billing cycle.</p>
        </div>
      )}
    </SettingsCard>
  );
}

function PlanButton({ action, plan, mailto }) {
  if (action === 'current') return <Button variant="light" className="w-full justify-center mt-1.5 mb-4" disabled aria-disabled>Current plan</Button>;
  const label = { upgrade: `Upgrade to ${plan}`, downgrade: `Downgrade to ${plan}`, choose: `Choose ${plan}` }[action];
  const live = action === 'upgrade' || action === 'choose';
  return <a className={`btn ${live ? 'btn--primary' : 'btn--light'} w-full justify-center mt-1.5 mb-4`} href={mailto}>{label}</a>;
}
