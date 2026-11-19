import test from 'node:test';
import assert from 'node:assert/strict';
import { tierFor, humanAge } from '../utils/join-gate-age.js';

const H = 3_600_000, D = 86_400_000;
const DEFAULTS = { kick_under_hours: 24, apply_under_days: 7 };

test('the three tiers, at the ages that define them', () => {
  assert.equal(tierFor(5 * 60_000, DEFAULTS), 'too_new');   // five minutes old
  assert.equal(tierFor(23 * H, DEFAULTS), 'too_new');
  assert.equal(tierFor(3 * D, DEFAULTS), 'apply');
  assert.equal(tierFor(30 * D, DEFAULTS), 'pass');
});

test('the boundaries are inclusive upward — "under 24h" means under, not up to', () => {
  assert.equal(tierFor(24 * H - 1, DEFAULTS), 'too_new');
  assert.equal(tierFor(24 * H, DEFAULTS), 'apply', 'exactly 24h old must be allowed to apply');
  assert.equal(tierFor(7 * D - 1, DEFAULTS), 'apply');
  assert.equal(tierFor(7 * D, DEFAULTS), 'pass', 'exactly a week old must pass untouched');
});

test('an application window configured shut degrades to a plain kick, never to a free pass', () => {
  // apply <= kick leaves no age that is "old enough to apply, too young to join".
  const shut = { kick_under_hours: 48, apply_under_days: 1 };
  assert.equal(tierFor(10 * H, shut), 'too_new');
  assert.equal(tierFor(47 * H, shut), 'too_new');
  assert.equal(tierFor(49 * H, shut), 'pass');
  for (let h = 0; h < 200; h++) assert.notEqual(tierFor(h * H, shut), 'apply');
});

test('applications can be turned off entirely with 0 days', () => {
  const off = { kick_under_hours: 24, apply_under_days: 0 };
  assert.equal(tierFor(2 * H, off), 'too_new');
  assert.equal(tierFor(25 * H, off), 'pass');
});

test('a missing config falls back to 24h / 7d rather than to nothing', () => {
  assert.equal(tierFor(2 * H, undefined), 'too_new');
  assert.equal(tierFor(3 * D, {}), 'apply');
  assert.equal(tierFor(8 * D, null), 'pass');
});

test('an account created in the future is not treated as ancient', () => {
  // Clock skew between Discord and us: a negative age must fail closed, not sail through.
  assert.equal(tierFor(-5000, DEFAULTS), 'too_new');
});

test('humanAge reads naturally at every scale', () => {
  assert.equal(humanAge(3 * 60_000), '3 minutes');
  assert.equal(humanAge(5 * H), '5 hours');
  assert.equal(humanAge(3 * D), '3 days');
  assert.equal(humanAge(30_000), '1 minutes');   // never "0 minutes"
});
