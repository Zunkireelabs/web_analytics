import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatKnowledgeLine, formatProductFacts, loadProductFactsFor } from './product-facts.js';

const ROWS = [
  { kind: 'capability', name: 'Online booking', category: 'Booking', description: 'Customers book slots online.' },
  { kind: 'flow', name: 'Booking flow', description: 'From search to attended.', details: { steps: ['Pick a service', 'Choose staff', 'Confirm'] } },
  { kind: 'pricing', name: 'Starter plan', details: { price: 'NPR 5,000/month', branches: 1 } },
  { kind: 'audience', name: 'Multi-branch spas', description: 'Spas and salons with several branches.' },
  { kind: 'proof', name: 'Khems Cleaning', description: 'Bookings up 70%.' },
];

describe('formatKnowledgeLine', () => {
  test('capability row without details matches the original positioning-guard line shape', () => {
    assert.equal(formatKnowledgeLine({ name: 'Online booking', category: 'Booking', description: 'Customers book slots online.', details: {} }),
      '- Online booking (Booking): Customers book slots online.');
    assert.equal(formatKnowledgeLine({ name: 'Bare', details: {} }), '- Bare');
  });
  test('renders numbered steps and other details', () => {
    const line = formatKnowledgeLine(ROWS[1]);
    assert.match(line, /1\. Pick a service 2\. Choose staff 3\. Confirm/);
    assert.match(formatKnowledgeLine(ROWS[2]), /price: NPR 5,000\/month \| branches: 1/);
  });
});

describe('formatProductFacts', () => {
  test('groups by kind in a stable, readable order', () => {
    const text = formatProductFacts(ROWS);
    const order = ['What the product does', 'How it works', 'Who it is for', 'Pricing', 'Proof points'].map((h) => text.indexOf(h));
    assert.ok(order.every((i) => i >= 0), text);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });
  test('empty or missing input yields an empty string', () => {
    assert.equal(formatProductFacts([]), '');
    assert.equal(formatProductFacts(undefined), '');
  });
  test('an unknown kind is treated as a capability rather than dropped or invented', () => {
    assert.match(formatProductFacts([{ kind: 'mystery', name: 'X' }]), /What the product does:\n- X/);
  });
});

describe('loadProductFactsFor — tenant safety', () => {
  const getKnowledge = async () => ROWS;
  test('a website tenant gets nothing, so its prompt is unchanged', async () => {
    assert.equal(await loadProductFactsFor({ id: 1, property_type: 'website' }, { getKnowledge }), '');
    assert.equal(await loadProductFactsFor({ id: 1 }, { getKnowledge }), '');
    assert.equal(await loadProductFactsFor(null, { getKnowledge }), '');
  });
  test('a product site gets its verified facts', async () => {
    const text = await loadProductFactsFor({ id: 9, property_type: 'product' }, { getKnowledge });
    assert.match(text, /Online booking/);
    assert.match(text, /How it works/);
  });
  test('only verified rows are requested', async () => {
    let status;
    await loadProductFactsFor({ id: 9, property_type: 'product' }, { getKnowledge: async (id, s) => { status = s; return []; } });
    assert.equal(status, 'verified');
  });
  test('a lookup failure fails open to an empty string, never blocking a draft', async () => {
    const text = await loadProductFactsFor({ id: 9, property_type: 'product' }, { getKnowledge: async () => { throw new Error('db down'); } });
    assert.equal(text, '');
  });
});
