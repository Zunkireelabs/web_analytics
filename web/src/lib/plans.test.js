import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, planAction, planPrice, planSaving, planStats, salesMailto, SALES_EMAIL } from './plans.js';

const agency = { audience: 'agencies', plan: 'Scale' };
const brand = { audience: 'brands', plan: 'Pro' };

describe('planAction', () => {
  test('marks the current plan and compares the rest by position', () => {
    assert.equal(planAction('agencies', 'Scale', agency), 'current');
    assert.equal(planAction('agencies', 'Essential', agency), 'downgrade');
    assert.equal(planAction('brands', 'Starter', brand), 'downgrade');
    assert.equal(planAction('brands', 'Advanced', brand), 'upgrade');
  });
  test('plans from the other audience are a choice, never an upgrade', () => {
    assert.equal(planAction('brands', 'Pro', agency), 'choose');
    assert.equal(planAction('agencies', 'Scale', brand), 'choose');
  });
});

describe('pricing', () => {
  test('brand annual prices are lower and the yearly saving matches the site', () => {
    const [starter, pro, advanced] = PLANS.brands.plans;
    assert.deepEqual([starter, pro, advanced].map((p) => planSaving(p, true)), [180, 480, 900]);
    assert.equal(planPrice(pro, true), 205);
    assert.equal(planPrice(pro, false), 245);
  });
  test('agency annual keeps the price and gives more credits', () => {
    const scale = PLANS.agencies.plans[2];
    assert.equal(planPrice(scale, true), 795);
    assert.equal(planSaving(scale, true), 0);
    assert.deepEqual(planStats(scale, false)[0], ['Monthly credits', '65,000']);
    assert.deepEqual(planStats(scale, true)[0], ['Credits (annual)', '85,000']);
  });
});

describe('salesMailto', () => {
  test('goes to us, naming the account, the current plan and the plan asked about', () => {
    const url = salesMailto({ target: 'Comprehensive', current: agency, email: 'a@b.co' });
    assert.ok(url.startsWith(`mailto:${SALES_EMAIL}?subject=`));
    const body = decodeURIComponent(url.split('&body=')[1]);
    assert.match(body, /Account: a@b\.co/);
    assert.match(body, /Current plan: Agency Scale/);
    assert.match(decodeURIComponent(url), /Plan enquiry: Agency Scale → Comprehensive/);
  });
});
