import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchCommissionAd, hasCommerceSignal, normalise, DEFAULT_PHRASES,
} from '../core/commission-spam-match.js';

const hit = (s, opts) => matchCommissionAd(s, opts);
const caught = (s, opts) => hit(s, opts) !== null;

// ── the message that started this: guild 1469931133981687873, 2026-08-03 04:34 UTC ──────────────
// Substring matching had `hmu for prices` and still let this through, because "more" sits between
// "for" and the ask. This is the regression test for the whole rewrite.
const ESCAPED = '***Custom Animated Emotes Done 🪻 \nHMU for more Details and Pricing!! 💜  ***';

test('the real bypassed message is now caught', () => {
  const r = hit(ESCAPED);
  assert.ok(r, 'expected a match');
  assert.equal(r.via, 'pattern');
  assert.equal(r.rule, 'contact-for-price');
});

test('the real bypassed message matched NO literal phrase (documents the original gap)', () => {
  const text = normalise(ESCAPED);
  const phrase = DEFAULT_PHRASES.map(normalise).find(p => text.includes(p));
  assert.equal(phrase, undefined, `unexpectedly matched phrase "${phrase}"`);
});

test('normalise strips markdown, emoji and newlines to bare words', () => {
  assert.equal(normalise(ESCAPED), 'custom animated emotes done hmu for more details and pricing');
});

// ── the interposed-word family the old list could never cover ───────────────────────────────────
test('contact + filler + strong ask', () => {
  for (const s of [
    'HMU for more details and pricing',
    'hmu for pricing',
    'dm me for my rates',
    'dm for the current prices',
    'pm me about commission rates',
    'hit me up for a quote',
    'inbox me to order',
    'slide into my dms for my prices',
    'msg me for rates',
  ]) assert.ok(caught(s), `missed: ${s}`);
});

test('leetspeak and spacing obfuscation still hits', () => {
  assert.ok(caught('hmu f0r m0re pr1c3s!!!'));
  assert.ok(caught('HMU   for    PRICING'));
  // NB: punctuation *inside* a word ("d.m m.e") splits it into separate tokens and is not caught.
  // normalise() deliberately treats punctuation as a word boundary; changing that to defeat
  // intra-word obfuscation would also start matching across unrelated words.
});

test('prices-in-DMs shape', () => {
  assert.ok(caught('prices are in my dms'));
  assert.ok(caught('rates in dms'));
});

test('commissions open family, without the literal phrase spelling', () => {
  for (const s of [
    'my commissions are now open!',
    'comms opened again',
    'currently accepting commissions',
    'commission slots remaining: 2',
  ]) assert.ok(caught(s), `missed: ${s}`);
});

// ── false positives: the cases the original comments explicitly warn about ──────────────────────
test('casual talk about commissions is NOT caught', () => {
  for (const s of [
    "what's the commission on that?",
    'the art commission board is over there',
    'I paid a 3% commission on the sale',
    'he got commissioned into the navy',
  ]) assert.equal(caught(s), false, `false positive: ${s}`);
});

test('flirt banter without a solicitation is NOT caught', () => {
  assert.equal(caught('slide into my dms 😏'), false);
  assert.equal(caught('dm me sometime'), false);
  assert.equal(caught('just dm me'), false);
});

test('"dm if interested" needs commerce corroboration', () => {
  // Previously a literal phrase, so every one of these was being deleted.
  assert.equal(caught('raid team forming, dm if interested'), false);
  assert.equal(caught('looking for a duo partner, dm me if interested'), false);
  assert.ok(caught('custom emotes, dm if interested'));
  assert.ok(caught('dm me if interested, $20 each'));
});

test('non-commercial "details / info" asks are NOT caught', () => {
  for (const s of [
    'pm me about details of the event',
    'dm me for details on the raid time',
    'hmu for info about the movie night',
    'message me for more information on the tournament bracket',
  ]) assert.equal(caught(s), false, `false positive: ${s}`);
});

test('tournament and event "slots" language is NOT caught', () => {
  for (const s of [
    'slots available for the scrim tonight',
    '3 slots open for the tournament',
    'open for business at 9',
  ]) assert.equal(caught(s), false, `false positive: ${s}`);
});

// ── the weak-ask tier: generic asks need corroboration ───────────────────────────────────────────
test('weak ask + commerce signal IS caught', () => {
  assert.ok(caught('dm me for details, $25 per piece'));
  assert.ok(caught('custom emotes! hmu for details'));
  assert.ok(caught('hmu for info, paypal only'));
});

test('weak ask alone is not, but the same sentence with a price is', () => {
  assert.equal(caught('hmu for more details'), false);
  assert.ok(caught('hmu for more details — 15 usd each'));
});

test('hasCommerceSignal picks up money, payment rails and product nouns', () => {
  assert.ok(hasCommerceSignal('$15'));
  assert.ok(hasCommerceSignal('20 usd'));
  assert.ok(hasCommerceSignal('cashapp me'));
  assert.ok(hasCommerceSignal('custom animated emotes'));
  assert.equal(hasCommerceSignal('see you at 8 tonight'), false);
  assert.equal(hasCommerceSignal('the raid details are posted'), false);
});

// ── guild overrides ─────────────────────────────────────────────────────────────────────────────
test('a custom phrase list disables the built-in patterns', () => {
  const opts = { phrases: ['selling my rig'], usePatterns: false };
  assert.equal(caught(ESCAPED, opts), false, 'built-in patterns leaked past a custom list');
  assert.ok(caught('selling my rig cheap', opts));
});

test('empty and non-string content is safe', () => {
  assert.equal(hit(''), null);
  assert.equal(hit(null), null);
  assert.equal(hit(undefined), null);
  assert.equal(hit('🎨🎨🎨'), null);
});

// ── the second bypass: guild 814321716872347648, message 1543121334450790412 ─────────────────────
// The first rewrite tolerated filler AFTER the preposition ("hmu for more details and pricing") but
// still demanded that the preposition follow the contact word immediately. One adverb defeated it:
// "DM me for details" was caught, "DM me NOW for details" was not. Same advertiser, same server,
// eight days later.
const ADVERB_BYPASS = '*** Make your stream impossible to ignore! ✨\n\nGive your viewers an '
  + 'unforgettable first impression with a custom animated screen made just for your stream! 🔥\n\n'
  + '💥 Limited-time discount available!\n📩 DM me now for details and let’s create something that '
  + 'makes your stream stand out!***';

test('an adverb between the contact word and the preposition no longer defeats the rule', () => {
  const r = hit(ADVERB_BYPASS);
  assert.ok(r, 'expected a match');
  assert.equal(r.rule, 'contact-for-details');
});

test('the same shapes, one word at a time', () => {
  for (const s of [
    'dm me now for details — limited-time discount',   // weak ask, discount corroborates
    'dm me today for pricing',
    'hmu anytime about rates',
    'pm us directly for a quote',
    'dm me right now for prices',
    'dm me now if interested, 20% off this week',
  ]) assert.ok(caught(s), `missed: ${s}`);
});

test('the plain forms still work — the pre-gap is optional', () => {
  assert.ok(caught('dm for prices'));
  assert.ok(caught('dm me for pricing'));
  assert.ok(caught('hmu for more details and pricing'));
});

// The pre-gap widens what the WEAK rules can reach, so the commerce signal has to carry more
// weight than before. These are the messages it has to keep alive.
test('a wider gap does not start eating ordinary conversation', () => {
  for (const s of [
    'dm me now for details on the raid time',
    'pm me later about info for the event',
    'dm me tomorrow if interested in the tournament',
    'hmu when you want to run some games',
    'dm me now about the meetup',
    'message me anytime about the bookings for our scrim',
    // the support reply that a different filter wrongly muted — must stay clean here too
    "Putting manually the dll file does have work the server don't automatically close and do not "
      + 'require steam running thanks',
  ]) assert.equal(caught(s), false, `false positive: ${s}`);
});

test('stream-graphics products are recognised as products', () => {
  assert.ok(hasCommerceSignal('custom animated screen'));
  assert.ok(hasCommerceSignal('custom scene transitions'));
  assert.equal(hasCommerceSignal('the screen went black'), false);
});

test('a discount is a price signal', () => {
  assert.ok(hasCommerceSignal('limited-time discount available'));
  assert.ok(hasCommerceSignal('30% off this week'));
});
