import { feedsForTenant } from './trend-feeds.js';
import { normalizeProfile } from '../../lib/business-profile.js';

// News feeds for a project that has a verified business profile. The choice is made from what the company SELLS, not from the words
// its customers' industry happens to share with a feed category:
//   - the company's OWN industry picks the primary feeds (software -> technology news; marketing services -> marketing news);
//   - the industries of its CUSTOMERS, its subjects and its products add at most a couple of feeds per category, as a secondary lens.
// A salon-booking software company therefore leads with technology news and only adds a little salon trade news, instead of leading with
// gym and fitness news because "salon" and "booking" appear in the wellness category's word list.
//
// The shared 5-key catalog (trend-feeds.js) is left exactly as it is: it also defines the industry vocabulary other code classifies
// against, so adding a key there would change how existing projects are classified. Extra groups live here and apply only to profiles.

const EXTRA_GROUPS = [
  {
    key: 'marketing',
    match: (s) => /\b(marketing (agency|agencies|services)|marketing and advertising|advertis\w*|demand generation|go-to-market|sales enablement|public relations|creative agency|media agency)\b/i.test(s),
    feeds: [
      { id: 'marketingweek', name: 'Marketing Week', url: 'https://www.marketingweek.com/feed/' },
      { id: 'martech', name: 'MarTech', url: 'https://martech.org/feed/' },
      { id: 'marketingdive', name: 'Marketing Dive', url: 'https://www.marketingdive.com/feeds/news/' },
    ],
  },
];

const MAX = 12;
const SECONDARY_PER_GROUP = 2;

export function feedsForProfile(profile) {
  const f = normalizeProfile(profile).fields;
  const own = f.ownIndustry.value?.label || '';
  if (!own) return [];
  const customerIndustries = f.targetCustomerIndustries.value || [];
  const topics = [...(f.coreTopics.value || []), ...customerIndustries];

  // The shared catalog, driven by the company's own industry and (as a secondary lens only) its subjects and customers.
  const catalog = feedsForTenant({ industries: [own], topics });

  // Extra groups: primary when the company's own industry or offering says so, secondary when only its subjects/customers do.
  const ownText = [own, f.subIndustry.value, ...(f.productsServices.value || []).map((x) => x.name)].filter(Boolean).join(' | ');
  const topicText = topics.join(' | ');
  const primaryExtra = []; const secondaryExtra = [];
  for (const g of EXTRA_GROUPS) {
    if (g.match(ownText)) primaryExtra.push(...g.feeds.map((x) => ({ ...x, category: g.key })));
    else if (g.match(topicText)) secondaryExtra.push(...g.feeds.slice(0, SECONDARY_PER_GROUP).map((x) => ({ ...x, category: g.key })));
  }

  // A secondary lens never leads: it follows the primary feeds from the company's own industry.
  const seen = new Set();
  return [...primaryExtra, ...catalog, ...secondaryExtra].filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))).slice(0, MAX);
}
