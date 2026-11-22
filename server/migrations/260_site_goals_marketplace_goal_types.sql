-- Marketplace goal types. A two-sided marketplace's success is growing each
-- side (sellers/providers who list, buyers/seekers who browse and transact)
-- and the inventory between them, which generate_leads / grow_sales only
-- approximate. Same additive CHECK-constraint edit as migration 177: every
-- existing value stays valid, so no existing row or reader is affected.
-- Guarded and idempotent.
ALTER TABLE site_goals DROP CONSTRAINT IF EXISTS site_goals_goal_type_check;
ALTER TABLE site_goals ADD CONSTRAINT site_goals_goal_type_check CHECK (goal_type IN (
  'generate_leads', 'increase_organic_traffic', 'increase_conversions',
  'reduce_bounce_rate', 'increase_organic_visibility', 'increase_qualified_traffic',
  'grow_bookings', 'grow_sales',
  'book_demos', 'grow_signups', 'activate_users',
  'grow_supply', 'grow_demand', 'grow_listings',
  'custom'
));
