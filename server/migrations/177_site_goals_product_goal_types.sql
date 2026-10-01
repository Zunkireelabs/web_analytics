-- Product-site goal types (Zennly work). The original enum (171) was built
-- for company/services sites: leads, traffic, bookings, sales. A SaaS product
-- site's real success metrics are booked demos, trial signups and activated
-- users, which the existing types only approximate ("increase_conversions").
-- 171's own header says adding a type is "a CHECK-constraint edit, not a
-- schema rewrite" — this is exactly that edit. Purely additive: every
-- existing value stays valid, so no existing row or reader is affected.
ALTER TABLE site_goals DROP CONSTRAINT IF EXISTS site_goals_goal_type_check;
ALTER TABLE site_goals ADD CONSTRAINT site_goals_goal_type_check CHECK (goal_type IN (
  'generate_leads', 'increase_organic_traffic', 'increase_conversions',
  'reduce_bounce_rate', 'increase_organic_visibility', 'increase_qualified_traffic',
  'grow_bookings', 'grow_sales',
  'book_demos', 'grow_signups', 'activate_users',
  'custom'
));
