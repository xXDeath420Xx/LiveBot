/*
 * This classifier runs on text recovered from images by OCR and a match applies a punitive action,
 * so both directions are pinned here. The benign cases are not decoration: the group-counting
 * scheme assumes each group is INDEPENDENT evidence, and the easiest way to break it is to add a
 * pattern that re-observes something another group already counts. That mistake is what made
 * "MrBeast announced he is giving away $50,000 in his new video" score three groups off a single
 * observation — the same shape as the character-spam filter counting spaces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scoreScamText, SIGNAL_GROUPS, MATCH_THRESHOLD } from '../core/scam-text-classifier.js';

const SCAMS = {
  'crypto casino (the original reference images)':
    "I'm excited to announce the launch of my very own crypto casino! To celebrate, I'm giving away "
    + '$5,600 to everyone who registers - and you can withdraw the bonus instantly. How to claim your '
    + 'reward: 1. Go to bozawin.com 2. Enter the special promo code',
  'creator giveaway impersonation':
    'MRBEAST OFFICIAL GIVEAWAY! I am giving away $50,000 to my fans! Go to mrbeast-drop.xyz and '
    + 'enter the code BEAST50 to claim your prize. Hurry, expires in 1 hour!',
  'free nitro':
    'FREE DISCORD NITRO for everyone! Claim your gift now at nitro-steam.top before it expires!',
  'steam gift card':
    'Steam gift card code giveaway! $100 free. Scan the QR code to receive your $100 now.',
  'airdrop':
    'Binance airdrop is live, claim your reward of 0.5 BTC. Visit the site and enter the promo code '
    + 'now, limited time only.',
};

// Every one of these mentions a brand, a giveaway or money — the words the scams use. What they do
// NOT have is a handoff, which is what separates talking about a thing from being sold it.
const BENIGN = {
  'news about a genuine giveaway':
    'MrBeast announced he is giving away $50,000 to subscribers in his new video. It has 12 million '
    + 'views already.',
  'warning other members': 'lol another mrbeast giveaway scam going around, dont click it',
  'steam sale chat': 'the steam summer sale has this game for $12 right now, honestly worth it',
  'a real server giveaway':
    'we are doing a giveaway for the new game, react to enter, winner gets picked friday',
  'crypto news': 'elon musk said binance would list it, the price went up $400 in an hour',
  'support ticket':
    'Putting manually the dll file does have work, the server don\'t automatically close and do not '
    + 'require steam running thanks',
  'casino minigame chat':
    'been playing that roulette minigame in the server all day, lost 5000 coins on the jackpot slots',
  'streamer going live': 'going live in 10 minutes! come hang out, we are playing the new update',
  'empty / no text recovered': '',
};

test('known scam families are flagged', () => {
  for (const [name, text] of Object.entries(SCAMS)) {
    const { matched, groups } = scoreScamText(text);
    assert.ok(matched, `missed: ${name} (only ${groups.join('+') || 'none'})`);
  }
});

test('ordinary text that uses the same words is not flagged', () => {
  for (const [name, text] of Object.entries(BENIGN)) {
    const { matched, groups } = scoreScamText(text);
    assert.equal(matched, false, `false positive on ${name}: ${groups.join('+')}`);
  }
});

test('no single observation can reach the threshold on its own', () => {
  // The independence property, asserted directly. If one added phrase trips MATCH_THRESHOLD groups
  // by itself then the groups are no longer separate evidence and the bar is decorative.
  const phrases = [
    'giving away $50,000', 'free nitro', 'claim your prize', 'crypto casino',
    'go to example.com', 'enter the code', 'limited time', 'instant withdraw',
  ];
  for (const p of phrases) {
    const { groups } = scoreScamText(p);
    assert.ok(groups.length < MATCH_THRESHOLD,
      `"${p}" alone reached ${groups.length} groups — it is being counted more than once`);
  }
});

test('brand names alone are never a signal', () => {
  // A group firing on a bare creator or exchange name would flag every screenshot that mentions
  // one. No pattern may match a name by itself.
  for (const name of ['mrbeast', 'mr beast', 'elon musk', 'binance', 'coinbase', 'steam', 'discord']) {
    const { groups } = scoreScamText(name);
    assert.deepEqual(groups, [], `bare brand name "${name}" fired: ${groups.join('+')}`);
  }
});

test('the reference images still score well clear of the bar', () => {
  // Guards against a future retune quietly stranding the images the blocklist was built from.
  // Uses the OCR text those images actually produce, kept inline so the test needs no OCR run.
  const referenceOcr = "MrBeast @MrBeast - 53m I'm excited to announce the launch of my very own "
    + "crypto casino! To celebrate, I'm giving away $5,600 to everyone who registers-and you can "
    + 'withdraw the bonus instantly. How to claim your reward: 1. Go to bozawin.com 2. Enter the special';
  const { matched, groups } = scoreScamText(referenceOcr);
  assert.ok(matched);
  assert.ok(groups.length >= MATCH_THRESHOLD + 1,
    `only ${groups.length} groups (${groups.join('+')}) — no margin left`);
});

test('every group is reachable and none is empty', () => {
  for (const [name, patterns] of Object.entries(SIGNAL_GROUPS)) {
    assert.ok(Array.isArray(patterns) && patterns.length, `group ${name} has no patterns`);
    for (const re of patterns) assert.ok(re instanceof RegExp, `group ${name} has a non-regex entry`);
  }
});

test('the 2026-09-13 lacewin wave scores well clear of the bar', () => {
  // Verbatim tesseract output from the screenshots posted into nine channels of guild
  // 961514092848382043 — OCR noise and all, because that is what the classifier is handed in
  // production. The classifier was never the reason this wave got through (it scores seven groups
  // here); the scanners never reached it. Pinned so a retune cannot make that excuse true later.
  const lacewinOcr = 'I am pleased to announce the launch of my own cryptocurrency casino '
    + 'linked to our recent launch of the Vyro project! To celebrate this big event, | am '
    + 'giving away $2,500 to everyone who registers, and you can withdraw the bonus immediately. '
    + 'How to claim your reward: 1. Go to lacewin.com 2. Enter the special promo code: MEGA '
    + '3. Receive your $2,500 bonus - play or withdraw. This post will be deleted an hour after '
    + 'publication, so only the fastest will find out about the bonus!';
  const { matched, groups } = scoreScamText(lacewinOcr);
  assert.ok(matched, `missed: ${groups.join('+')}`);
  assert.ok(groups.length >= MATCH_THRESHOLD + 2,
    `only ${groups.length} groups (${groups.join('+')}) — no margin left`);
});

test('the withdrawal-confirmation screenshot carries the wave on its own', () => {
  // The second half of the same post: a casino cashier page with no giveaway copy at all. It has to
  // stand up by itself, because a burst does not always lead with the announcement.
  const cashierOcr = 'SLOTS WITHDRAW 1. Select a Withdraw Method CRYPTO BANK CARD '
    + '2. Select Crypto to Withdraw Tether 3. Select Network ERC20 BEP20 TRC20 '
    + 'Withdrawal Success! Your Withdrawal of $2700.00 Was Successfull '
    + 'The money will be transferred to your specified wallet. Deposit Bonuses VIP-Club';
  const { matched, groups } = scoreScamText(cashierOcr);
  assert.ok(matched, `missed: ${groups.join('+')}`);
});

test('ordinary game and stream content is not a scam', () => {
  // The scanners now read every image, so whatever this classifier gets wrong is applied to normal
  // posts — and in these servers "normal" is game screenshots, store pages and giveaways. Each case
  // below is something a member legitimately posts; each must stay under the bar.
  //
  // The Steam gift card case is not hypothetical: it flagged at exactly three groups
  // (giveaway + money + impersonation) until the prize-noun pattern was narrowed, which meant a
  // streamer raffling a gift card was muted for running a giveaway.
  const ORDINARY = [
    ['game HUD', 'INVENTORY Gold 24,500 Ammo 120 Health 87% Level 42 Next objective: clear the outpost'],
    ['store page', 'Baldurs Gate 3 -20% $59.99 $47.99 Add to Cart Special Offer! Offer ends in 2 days'],
    ['in-game casino', 'THE DIAMOND CASINO & RESORT Lucky Wheel Place your bet Chips: $150,000 Jackpot!'],
    ['slots minigame', 'SLOTS - You won 500 coins! Spin again? Jackpot 10,000 coins Wager: 50'],
    ['streamer giveaway', 'GIVEAWAY! We are giving away a $50 Steam gift card to celebrate 1000 '
      + 'followers. Ends tonight, do not miss it! Enter in chat'],
    ['genuine nitro gift', 'You received a gift! Discord Nitro - 1 month Claim your gift'],
    ['crypto chat', 'bought some ETH at $2,400 last week, wallet is up 12% now. thinking about BTC'],
    ['esports prize pool', 'THE INTERNATIONAL Prize Pool $40,000,000 Grand Final starts in 3 hours'],
    ['game redeem code', 'Redeem code GENSHIN2026 for 60 Primogems. Use the code before it expires!'],
    ['twitch sub panel', 'Subscribe for emotes! Tier 1 $4.99 Tier 2 $9.99 Bits available. Limited time sub badge'],
  ];
  for (const [label, text] of ORDINARY) {
    const { matched, groups } = scoreScamText(text);
    assert.equal(matched, false, `${label} flagged as a scam: ${groups.join('+')}`);
  }
});

test('a raffled prize is not evidence on top of the giveaway that raffles it', () => {
  // Naming the prize re-observes what `giveaway` already counted. The scam shape is that the thing
  // is free, or that a code is being handed over — not that a card exists.
  assert.equal(scoreScamText('giving away a $50 Steam gift card').matched, false);
  const scam = scoreScamText('FREE Steam wallet code! $100 balance, claim your reward, enter the code now');
  assert.ok(scam.matched, `scam shape missed: ${scam.groups.join('+')}`);
  assert.ok(scam.groups.includes('impersonation'));
});
