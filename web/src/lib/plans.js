// The SuperRank plans, as published on superrank.si/pricing (brands) and
// superrank.si/pricing-agencies (agencies). One place, so the Plan & billing panel
// and any future billing code read the same numbers.
//
// Agency plans do not have a lower annual price on the site: annual billing gives
// bonus credits (`creditsAnnual`) at the same monthly price.

export const SALES_EMAIL = 'info@zunkireelabs.com';

export const AUDIENCES = [
  { key: 'brands', label: 'For Brands' },
  { key: 'agencies', label: 'For Agencies' },
];

const brandFeatures = [['Unlimited users', true], ['Custom prompt setup', false], ['API access', false], ['Single sign-on (SSO)', false]];
const agencyFeatures = [['Centralized billing', true], ['Bonus credits on annual', true]];

export const PLANS = {
  brands: {
    description: 'Unlimited users on every plan. Choose 3 AI models, tracked daily. Annual billing saves 15%.',
    savingPill: 'Save 15%',
    plans: [
      { name: 'Starter', monthly: 95, annual: 80, stats: [['Tracked prompts', '50'], ['Projects', '1'], ['AI models', 'Choose 3'], ['Tracking', 'Daily']], features: brandFeatures },
      { name: 'Pro', monthly: 245, annual: 205, popular: true, stats: [['Tracked prompts', '150'], ['Projects', '2'], ['AI models', 'Choose 3'], ['Tracking', 'Daily']], features: brandFeatures },
      { name: 'Advanced', monthly: 495, annual: 420, stats: [['Tracked prompts', '350'], ['Projects', 'Multiple'], ['AI models', 'Choose 3'], ['Tracking', 'Daily']], features: brandFeatures },
    ],
    custom: { name: 'Enterprise', description: 'Custom prompts, all AI models, unlimited projects, API access and SSO — on an annual contract.', cta: 'Talk to sales' },
  },
  agencies: {
    description: 'Credits are shared across all your clients, with one centralized bill. Annual billing adds bonus credits.',
    savingPill: 'Bonus credits',
    plans: [
      { name: 'Essential', monthly: 245, popular: true, credits: 10000, creditsAnnual: 15000, clients: 'First clients', features: agencyFeatures },
      { name: 'Growth', monthly: 495, credits: 25000, creditsAnnual: 35000, clients: '3–10 clients', features: agencyFeatures },
      { name: 'Scale', monthly: 795, credits: 65000, creditsAnnual: 85000, clients: '11–25+ clients', features: agencyFeatures },
    ],
    custom: { name: 'Comprehensive', description: 'Unlimited credits for enterprise agencies serving global brands — on an annual contract.', cta: "Let's talk" },
  },
};

export const fmtNumber = (n) => n.toLocaleString('en-US');

// The rows shown at the top of a plan card. Agency plans switch from monthly to
// annual credits with the billing period.
export function planStats(plan, annual) {
  if (plan.stats) return plan.stats;
  return [
    [annual ? 'Credits (annual)' : 'Monthly credits', fmtNumber(annual ? plan.creditsAnnual : plan.credits)],
    ['Clients managed', plan.clients],
  ];
}

export const planPrice = (plan, annual) => (annual && plan.annual ? plan.annual : plan.monthly);
export const planSaving = (plan, annual) => (annual && plan.annual ? (plan.monthly - plan.annual) * 12 : 0);

// What the button on a plan card says, from where the account is now. A different
// audience's plans are a switch, not an upgrade.
export function planAction(audience, planName, current) {
  if (audience !== current.audience) return 'choose';
  const list = PLANS[audience].plans;
  const here = list.findIndex((p) => p.name === current.plan);
  const there = list.findIndex((p) => p.name === planName);
  if (there === here) return 'current';
  return there < here ? 'downgrade' : 'upgrade';
}

// Customers talk to us by email, not through the public book-a-demo page. The
// message already says who is asking and which plan they are on.
export function salesMailto({ target, current, email }) {
  const now = `${current.audience === 'agencies' ? 'Agency ' : ''}${current.plan}`;
  const subject = `Plan enquiry: ${now} → ${target}`;
  const body = `Hi SuperRank team,\n\nI would like to talk about the ${target} plan.\n\nAccount: ${email || 'unknown'}\nCurrent plan: ${now}`;
  return `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
