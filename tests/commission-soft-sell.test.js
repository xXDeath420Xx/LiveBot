import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCommissionAd, scoreSoftSell, matchCommissionAd,
} from '../core/commission-spam-match.js';

const evaluate = (s, opts) => evaluateCommissionAd(s, opts);
const action = (s, opts) => evaluate(s, opts)?.action ?? null;

// ── the message that motivated the tier: a portfolio post with no ask at all ─────────────────────
const SOFT_SELL = `Recently finished this VTuber branding package for one of my client
This project included a custom VTuber logo and matching banner designed around a clean black & gold theme I had a lot of fun bringing this concept to life and I'd genuinely love to hear what you all think
Your feedback means a lot to me so feel free to share your thoughts Whether it's the composition, colors, typography, or overall design, I'd really appreciate your honest opinions 💛`;

test('the soft-sell message is caught and deleted', () => {
  const r = evaluate(SOFT_SELL);
  assert.ok(r, 'expected a verdict');
  assert.equal(r.action, 'delete');
  assert.equal(r.via, 'soft-sell');
});

test('it scores on client work, package, framing and product menu', () => {
  const { score, signals } = scoreSoftSell(SOFT_SELL);
  for (const key of ['client-work', 'service-package', 'portfolio-frame', 'product', 'product-menu']) {
    assert.ok(signals.includes(key), `missing signal: ${key}`);
  }
  assert.ok(score >= 6, `score ${score} should clear the delete threshold`);
});

test('it matched NO phrase and NO pattern — documents why the tier exists', () => {
  assert.equal(matchCommissionAd(SOFT_SELL), null);
});

// ── the evasion family this generalises to ──────────────────────────────────────────────────────
test('other ask-free portfolio ads are caught', () => {
  for (const s of [
    'Just delivered this full streaming package for a client — overlays, panels and alerts all matched to their brand. Thoughts?',
    'Another logo done for one of my clients! Slots are open again if anyone wants something similar.',
    'Latest project for a paying client: custom Live2D model + banner. Portfolio on my behance.',
    'Recently completed a rebrand package — new logo, new overlays, new thumbnails. Starting at $40.',
  ]) assert.equal(action(s), 'delete', `missed: ${s}`);
});

test('thinner versions land in review rather than deletion', () => {
  // Client work + a single product noun: suggestive, not conclusive. A human decides.
  assert.equal(action('Finished this banner for a client last night'), 'review');
});

// ── false positives: this tier must not touch people sharing their own work ─────────────────────
test('a hobbyist sharing art is NOT caught', () => {
  for (const s of [
    'Just finished this drawing of my OC, what do you all think?',
    "Made a new banner for my own channel, I'd love your honest opinions on the typography",
    'finally finished this piece I have been working on for months! feedback welcome 💛',
    'drew this for my friend as a birthday gift, hope she likes it',
    'here is my new pfp, thoughts?',
  ]) assert.equal(action(s), null, `false positive: ${s}`);
});

test('someone who COMMISSIONED art and is showing it off is NOT caught', () => {
  for (const s of [
    'look at the amazing emotes I got from my artist!! so happy with them',
    'my new model just got delivered and I am obsessed, artist did such a good job',
    'shoutout to the person who made my overlays, they turned out great',
  ]) assert.equal(action(s), null, `false positive: ${s}`);
});

test('ordinary server talk containing the vocabulary is NOT caught', () => {
  for (const s of [
    'the client patch dropped today, servers are down',
    'we just finished the raid, took 3 hours',
    'my client keeps crashing when I alt tab',
    'slots are filling up for the tournament, sign up now',
    'I paid $40 for this game and it does not even launch',
  ]) assert.equal(action(s), null, `false positive: ${s}`);
});

test('a single signal is never enough on its own, however heavy', () => {
  assert.equal(action('I do freelance work irl'), null);          // client-work alone (3)
  assert.equal(action('that skin costs $25 in the shop'), null);  // money alone (3)
  assert.equal(scoreSoftSell('I do freelance work irl').signals.length, 1);
});

// ── thresholds and adaptation ───────────────────────────────────────────────────────────────────
test('thresholds are tunable per guild', () => {
  const thin = 'Finished this banner for a client last night';
  assert.equal(action(thin), 'review');
  assert.equal(action(thin, { deleteAt: 4 }), 'delete', 'stricter guild should delete it');
  assert.equal(action(thin, { reviewAt: 99, deleteAt: 99 }), null, 'looser guild should ignore it');
});

test('scoreBoost lowers the bar for a known repeat advertiser', () => {
  const thin = 'Finished this banner for a client last night';
  assert.equal(action(thin), 'review');
  assert.equal(action(thin, { scoreBoost: 2 }), 'delete');
});

test('a guild on its own phrase list gets no soft-sell tier', () => {
  assert.equal(action(SOFT_SELL, { phrases: ['selling my rig'], usePatterns: false }), null);
});

test('explicit solicitations still delete via the original tiers, unscored', () => {
  const r = evaluate('commissions open! dm me for prices');
  assert.equal(r.action, 'delete');
  assert.equal(r.via, 'phrase');
});

test('empty and non-string content is safe', () => {
  for (const v of ['', null, undefined, '🎨🎨🎨']) assert.equal(evaluate(v), null);
});
