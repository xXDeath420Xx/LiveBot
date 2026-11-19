/*
 * Commission / paid-work advertising — the pure matcher.
 *
 * Split out of commission-spam-filter.js so it can be imported WITHOUT pulling in the shared DB
 * pool. One-off scripts (the retroactive backfill) and the unit tests need the matching logic and
 * nothing else; importing the filter itself opens `utils/db.js` and hangs a standalone script.
 *
 * Two matching strategies, in order:
 *
 *   1. PHRASES — literal substring hits, the original mechanism. A guild that has replaced the
 *      default list with its own phrases gets ONLY this, because "replace the defaults" has to mean
 *      what it says; we don't get to smuggle built-in patterns back in behind their choice.
 *
 *   2. PATTERNS — regexes over the same normalised text, used only when the guild is on the default
 *      list. These exist because substring matching cannot survive an interposed word: the list had
 *      `hmu for prices` and still sailed past "HMU for more Details and Pricing!!", since "more"
 *      sits in the middle. Spelling out every filler permutation is unwinnable; a bounded gap is not.
 *
 * FALSE POSITIVES ARE THE EXPENSIVE FAILURE. A miss leaves one ad up for a moderator to catch; a
 * false positive deletes a member's real message, and the retroactive backfill would do it in bulk
 * and unattended. So the ask-words are tiered: unambiguously commercial ones ("pricing", "rates")
 * match on their own, while generic ones ("details", "info") additionally require a commerce signal
 * somewhere in the message. That is what keeps "pm me about details of the event" alive.
 */

import { foldConfusables } from '../utils/text-fold.js';

// Built-in phrases. Matched case-insensitively as substrings after light normalisation (see below),
// so "Commissions OPEN!!", "comms  open" and "c0mmissions open" are all caught. Deliberately anchored
// on the "<thing> open" advertising shape rather than the bare word "commission", so "what's the
// commission on that?" or "the art commission board" do NOT trip it.
// Grouped so the slash-command help embed and the dashboard page render the same categories the
// matcher uses — one source of truth. NB the "selling" group is deliberately tight: no bare
// "slots available" / "starting at" / "open for business" (they false-positive on tournament slots,
// event times and casual chat). Each DM variant is spelled out because matching is substring-based.
export const PHRASE_GROUPS = Object.freeze([
  { key: 'art', icon: '🎨', title: 'Art & commission advertising',
    desc: 'The GFX-artist, VTuber-rig and artwork “commissions open” spam this started with.',
    phrases: ['commissions open', 'commission open', 'comms open', 'comms are open', 'commissions are open',
      'commission slots open', 'commission slots available', 'open for commissions', 'open for comms',
      'taking commissions', 'accepting commissions', 'commissions available', 'dm for commissions',
      'commission me', 'vtuber commissions', 'vtube commissions', 'model commissions', 'rigging commissions',
      'gfx commissions', 'art commissions open', 'commission sheet', 'price sheet'] },
  { key: 'dm', icon: '💬', title: '“DM me to buy” solicitation',
    desc: 'Every common way of saying “message me for prices.”',
    // NB the generic asks — "dm for details", "dm me for info", "dm if interested" — used to live
    // here as literals and were deleting real messages ("dm me for details on the raid time",
    // "raid team, dm if interested"). They now go through the weak pattern tier instead, which
    // requires a commerce signal in the same message. Anything unambiguously commercial stays here.
    phrases: ['dm for prices', 'dm me for prices', 'dm for pricing', 'dm me for pricing', 'dm for a price',
      'dm for rates', 'dm for a quote', 'dm for quotes',
      'dm to order', 'dm me to order', 'dm to buy', 'dm me to buy',
      // Plural "DMs" variants — spam almost always says "slide into my DMs for…", not "DM me".
      'dms for prices', 'dms for pricing', 'dms for a price', 'dms for rates',
      'dms for a quote', 'dms to order', 'dms to buy',
      // The "slide into my DMs for <sale>" opener — kept with the trailing "for" so plain flirt-banter
      // ("slide into my dms 😏") is NOT caught, only the solicitation continuation.
      'slide into my dms for', 'slide in my dms for', 'slide into the dms for', 'slide into my dms for prices',
      'prices in dm', 'prices in dms', 'price in dm', 'price in dms', 'pricing in dms',
      'message me for prices',
      'hmu for prices', 'hmu for commissions', 'hit me up for prices'] },
  { key: 'sell', icon: '💵', title: 'Selling a service or paid work',
    desc: 'Order-taking and payment call-outs — kept tight, no bare “selling” or “for sale.”',
    phrases: ['now taking orders', 'per piece', 'paypal only', 'cashapp only', 'venmo only'] },
  { key: 'boost', icon: '📈', title: 'Followers, boosting & account sales',
    desc: 'The “grow your account” / cheap-Nitro / account-flipping spam that drifts through servers.',
    phrases: ['cheap followers', 'buy followers', 'followers for sale', 'grow your following', 'grow your account',
      'boost your server', 'boosting service', 'cheap boosting', 'buy subscribers', 'cheap subs',
      'selling accounts', 'accounts for sale', 'cheap accounts', 'buy nitro', 'free nitro'] },
]);

export const DEFAULT_PHRASES = Object.freeze(PHRASE_GROUPS.flatMap(g => g.phrases));

/**
 * Normalise so trivial obfuscation (extra spaces, leetspeak, punctuation between words) still hits.
 * Lookalike letters, accents and invisible characters go through the shared folder (utils/text-fold.js)
 * first; the leetspeak set here stays deliberately small (prices like "$5" must not become words).
 */
export function normalise(s) {
  return foldConfusables(s)
    .replace(/[0]/g, 'o').replace(/[1]/g, 'i').replace(/[3]/g, 'e').replace(/[@]/g, 'a').replace(/[$]/g, 's')
    .replace(/[^a-z ]+/g, ' ')   // drop punctuation/emoji, keep word boundaries
    .replace(/\s+/g, ' ')
    .trim();
}

// ── pattern vocabulary ───────────────────────────────────────────────────────
// All of these run against normalised text, which is [a-z ] only — so \b behaves and there is no
// need to escape anything. Keep them as source strings so the pieces stay readable and reusable.

// How someone tells you to contact them.
const CONTACT = '(?:hmu|dm|dms|pm|pms|inbox|message me|msg me|hit me up|slide (?:into|in) (?:my|the) dms)';

// Asks that are commercial on their own — no corroboration needed.
const ASK_STRONG = '(?:prices?|pricing|rates?|quotes?|commissions?|comms|orders?)';

// Asks that are commercial only in context. "dm me for details" is spam; "pm me about details of
// the raid time" is not. These require hasCommerceSignal() to also fire.
const ASK_WEAK = '(?:details|info|information|bookings?)';

// Filler words tolerated between "for" and the ask — this is the whole point of the rewrite.
// "hmu for more details and pricing" needs three to reach "pricing" ("more details and").
// Strong asks get the wider gap because they cannot really be reached by accident; weak asks are
// kept tight so the match cannot wander out of the clause it started in.
const GAP_STRONG = '(?:[a-z]+ ){0,3}';
const GAP_WEAK = '(?:[a-z]+ ){0,2}';

// The SAME problem on the other side of the preposition, which the first pass missed entirely.
// The rules used to demand that "for" follow the contact word immediately (optionally via "me"),
// so "DM me NOW for details" — one adverb — walked past every contact rule while the near-identical
// "DM me for details" was caught. "hmu anytime about pricing" and "dm us today for rates" are the
// same shape. Tolerating a couple of words here costs nothing the ask itself does not already
// guard: a strong ask is commercial on its own, and a weak one still needs a commerce signal.
const PRE_GAP = '(?:(?:me|us) )?(?:[a-z]+ ){0,2}';

/**
 * Commerce corroboration, checked against the RAW message (not the normalised form, which strips
 * digits and currency symbols and would throw away the strongest evidence there is).
 */
export function hasCommerceSignal(raw) {
  const s = String(raw || '').toLowerCase();
  return (
    /[$€£]\s?\d/.test(s) ||                                   // "$15", "£ 20"
    /\b\d+\s?(?:usd|eur|gbp|dollars?|euros?|quid)\b/.test(s) || // "15 usd"
    /\b(?:paypal|cashapp|cash app|venmo|zelle|ko-?fi|patreon|boosty|throne)\b/.test(s) ||
    /\b(?:price|prices|pricing|rate|rates|quote|cost|costs|payment|paid|cheap|discount|sale)\b/.test(s) ||
    /\b\d+\s?%\s?off\b/.test(s) ||                             // "20% off"
    /\blimited[- ]time\b/.test(s) ||                            // the oldest sales line there is
    /\b(?:commission|commissions|comms)\b/.test(s) ||
    /\bper (?:piece|slot|item|design|character)\b/.test(s) ||
    // "custom emotes", "custom banner" — the product half of a product+contact ad.
    /\bcustom(?:ised|ized)?\s+(?:animated\s+)?(?:art|artwork|emotes?|emojis?|banners?|overlays?|rigs?|riggings?|models?|logos?|pfps?|avatars?|animations?|thumbnails?|badges?|panels?|alerts?|screens?|scenes?|transitions?|stingers?|widgets?|backgrounds?|intros?|outros?)\b/.test(s)
  );
}

// ── soft-sell / portfolio advertising ────────────────────────────────────────
/*
 * The third tier, and a different shape of problem from the first two.
 *
 * Phrases and patterns both key on an ASK — "commissions open", "dm me for prices". Advertisers
 * worked that out and dropped the ask entirely:
 *
 *   "Recently finished this VTuber branding package for one of my clients. This project included a
 *    custom VTuber logo and matching banner… I'd genuinely love to hear what you all think."
 *
 * There is no solicitation to match. It is a portfolio post that establishes the poster as someone
 * who does paid work, names the deliverables, and lets interested readers DM unprompted. The
 * feedback request on the end is camouflage — and it is also exactly what a hobbyist sharing art
 * writes, which is why it carries no weight here.
 *
 * No single one of these signals is safe to act on alone: "banner" is a word, "just finished this"
 * is what anyone says about a drawing. What separates an ad from a member sharing their work is
 * evidence of doing the work FOR SOMEONE, PROFESSIONALLY — clients, packages, booking, a shop link.
 * So this tier scores rather than matches, and a score only becomes a deletion when several
 * independent signals agree.
 *
 * Weights are deliberately lopsided: 'client-work' and 'shop-link' are near-conclusive on the
 * "is this a business?" question, while product nouns are worth almost nothing on their own.
 */
// NB the stream-graphics half of this list (screens, scenes, transitions, stingers, widgets) was
// missing, so "a custom animated screen made just for your stream" scored zero products.
const PRODUCT_NOUN = '(?:logos?|banners?|overlays?|emotes?|emojis?|rigs?|riggings?|models?|pfps?|avatars?|thumbnails?|badges?|panels?|alerts?|intros?|outros?|headers?|artworks?|illustrations?|portraits?|refs?|reference sheets?|vtuber models?|l2d|live2d|screens?|scenes?|transitions?|stingers?|widgets?)';

export const SOFT_SELL_SIGNALS = Object.freeze([
  { key: 'client-work', weight: 3, label: 'work done for a client',
    // The single strongest tell. Hobbyists do not have clients; people who charge money do.
    re: /\b(?:for (?:one of )?(?:my|our|a|another) (?:client|customer|buyer)s?\b|\bclients?['’]? (?:work|project|order|brief|request)\b|\bfor (?:a|my) (?:paying )?(?:client|customer)\b|\bpaid (?:work|project|gig)\b|\bfreelanc(?:e|ing|er))/ },

  { key: 'shop-link', weight: 3, label: 'portfolio or storefront link',
    re: /\b(?:fiverr|behance|artstation|carrd\.co|linktr\.ee|ko-?fi\.com|gumroad|etsy|upwork|payhip|throne\.(?:me|com)|vgen\.co)\b/ },

  { key: 'service-package', weight: 2, label: 'service package / bundle language',
    re: /\b(?:branding|design|logo|graphics?|starter|content|stream(?:ing)?|full|complete|rebrand)\s+(?:packages?|bundles?|kits?|packs?)\b|\b(?:packages?|bundles?)\s+(?:start(?:ing)?|available|include)/ },

  { key: 'booking', weight: 2, label: 'availability / booking language',
    // "slots" alone is a tournament word, so it must be qualified by booking intent here.
    re: /\b(?:slots? (?:are )?(?:open|available|left|remaining|filling)|now booking|booking (?:is )?open|accepting (?:new )?(?:clients?|orders?|projects?|work)|waitlist|queue is open|dm to (?:book|reserve))\b/ },

  { key: 'portfolio-frame', weight: 1, label: 'delivered-work framing',
    re: /\b(?:recently|just|finally|another one|latest)\s+(?:finished|completed|delivered|wrapped(?: up)?|done|dropped)\b|\b(?:latest|newest|another)\s+(?:project|piece|commission|design|work)\b|\bproject included\b/ },

  { key: 'money', weight: 3, label: 'price or payment rail',
    // A discount is a price by implication — nothing is discounted unless it is being sold — and
    // "limited-time offer" is the oldest sales line there is. Both were invisible here.
    re: /[$€£]\s?\d|\b\d+\s?(?:usd|eur|gbp|dollars?|euros?)\b|\b(?:paypal|cashapp|cash app|venmo|zelle|boosty)\b|\bstarting at\b|\bper (?:piece|slot|item|design|character)\b|\bdiscount(?:s|ed)?\b|\b\d+\s?% ?off\b|\blimited[- ]time\b/ },

  { key: 'product', weight: 1, label: 'commissionable product named',
    re: new RegExp(`\\b${PRODUCT_NOUN}\\b`) },
]);

// A service menu, not a single drawing: naming several distinct deliverables in one post is what a
// price list looks like with the prices removed.
const PRODUCT_NOUN_GLOBAL = new RegExp(`\\b${PRODUCT_NOUN}\\b`, 'g');

/**
 * Score a message on the soft-sell signals above.
 *
 * Runs against lightly-cleaned text rather than normalise(), which strips digits, currency symbols
 * and dots — i.e. exactly the evidence 'money' and 'shop-link' depend on.
 *
 * @returns {{score:number, signals:string[]}}
 */
export function scoreSoftSell(raw) {
  const s = String(raw || '').toLowerCase().replace(/\s+/g, ' ');
  if (!s) return { score: 0, signals: [] };

  let score = 0;
  const signals = [];
  for (const sig of SOFT_SELL_SIGNALS) {
    if (!sig.re.test(s)) continue;
    score += sig.weight;
    signals.push(sig.key);
  }

  const distinctProducts = new Set((s.match(PRODUCT_NOUN_GLOBAL) || []).map(w => w.replace(/s$/, '')));
  if (distinctProducts.size >= 2) {
    score += 1;
    signals.push('product-menu');
  }

  return { score, signals };
}

/**
 * Regex rules applied when a guild is on the default phrase list. `weak: true` means the rule only
 * counts with a commerce signal alongside it.
 */
export const PATTERN_RULES = Object.freeze([
  { key: 'contact-for-price', weak: false,
    label: 'contact me for <price/rates/commissions>',
    re: new RegExp(`\\b${CONTACT}\\b\\s+${PRE_GAP}(?:for|to|about|abt)\\s+${GAP_STRONG}\\b${ASK_STRONG}\\b`) },

  { key: 'contact-for-details', weak: true,
    label: 'contact me for <details/info> + commerce signal',
    re: new RegExp(`\\b${CONTACT}\\b\\s+${PRE_GAP}(?:for|to|about|abt)\\s+${GAP_WEAK}\\b${ASK_WEAK}\\b`) },

  { key: 'contact-if-interested', weak: true,
    label: 'DM me if interested + commerce signal',
    // "raid team, dm if interested" is not spam; "custom emotes, dm if interested" is. The commerce
    // signal is what separates them, which is why this is not a literal phrase any more.
    re: new RegExp(`\\b${CONTACT}\\b\\s+${PRE_GAP}(?:if|when)\\s+(?:you(?:\\s*re|\\s+are)?\\s+)?(?:interested|keen|want)\\b`) },

  { key: 'price-in-dms', weak: false,
    label: '<prices> in my DMs',
    re: new RegExp(`\\b${ASK_STRONG}\\b\\s+(?:are\\s+|is\\s+|r\\s+)?in\\s+(?:my\\s+|the\\s+)?(?:dm|dms|pm|pms|inbox)\\b`) },

  { key: 'comms-open', weak: false,
    label: 'commissions are open / available',
    // Each qualifier is independently optional so "commissions are now open" works as well as
    // "commissions open" — a single alternation group would consume "are" and then choke on "now".
    re: /\b(?:commissions?|comms)\s+(?:(?:are|is|r)\s+)?(?:now\s+)?(?:currently\s+)?(?:open|opened|available)\b/ },

  { key: 'open-for-comms', weak: false,
    label: 'open / taking / accepting commissions',
    re: /\b(?:open|opened|taking|accepting|available)\s+(?:for\s+)?(?:commissions?|comms)\b/ },

  { key: 'comm-slots', weak: false,
    label: 'commission slots open',
    // Deliberately requires the word "commission" — bare "slots available" false-positives on
    // tournament sign-ups and event scheduling, which is why it was never a phrase either.
    re: /\bcommission\s+slots?\s+(?:are\s+|now\s+)?(?:open|available|left|remaining)\b/ },
]);

/**
 * Decide whether a message is a commission/paid-work ad.
 *
 * @param {string} content raw message content
 * @param {object} [opts]
 * @param {string[]} [opts.phrases] phrase list in force; defaults to DEFAULT_PHRASES
 * @param {boolean} [opts.usePatterns] run the regex rules too; defaults to true. Callers pass false
 *        when the guild has overridden the phrase list with its own.
 * @returns {{matched: string, via: 'phrase'|'pattern', rule?: string}|null}
 */
export function matchCommissionAd(content, opts = {}) {
  if (!content) return null;
  const { phrases = DEFAULT_PHRASES, usePatterns = true } = opts;

  const text = normalise(content);
  if (!text) return null;

  const phrase = phrases.map(normalise).filter(Boolean).find(p => text.includes(p));
  if (phrase) return { matched: phrase, via: 'phrase' };

  if (!usePatterns) return null;

  for (const rule of PATTERN_RULES) {
    const hit = text.match(rule.re);
    if (!hit) continue;
    if (rule.weak && !hasCommerceSignal(content)) continue;
    return { matched: hit[0].trim(), via: 'pattern', rule: rule.key };
  }

  return null;
}

// Default score at which a soft-sell post is deleted outright, and the (lower) score at which it is
// merely put in front of a moderator. The gap between them is the whole safety margin: the tier is
// inference rather than a quoted solicitation, so the borderline band goes to a human instead of
// being guessed at. Both are tunable per guild.
export const SOFT_SELL_DELETE_AT = 6;
export const SOFT_SELL_REVIEW_AT = 4;

/**
 * Full verdict for a message, including the soft-sell tier.
 *
 * Kept separate from matchCommissionAd() on purpose. That function is also used by
 * scripts/commission-spam-backfill.mjs, which deletes historical messages in bulk and unattended —
 * exactly the context where an inferred, scored judgement must NOT be allowed to act on its own.
 * Callers that want the soft-sell tier have to ask for it.
 *
 * @param {string} content raw message content
 * @param {object} [opts] as matchCommissionAd, plus:
 * @param {boolean} [opts.softSell] enable the soft-sell tier (default true when patterns are on)
 * @param {number}  [opts.deleteAt]  score for automatic deletion
 * @param {number}  [opts.reviewAt]  score for moderator review
 * @param {number}  [opts.scoreBoost] added to the score before thresholding — how a guild's own
 *        confirmed history lowers the bar for a repeat advertiser.
 * @returns {{action:'delete'|'review', via:string, matched:string, rule?:string,
 *            score?:number, signals?:string[]}|null}
 */
export function evaluateCommissionAd(content, opts = {}) {
  if (!content) return null;
  const { usePatterns = true } = opts;

  // An explicit solicitation is still an explicit solicitation — unchanged behaviour, straight to
  // delete, no scoring involved.
  const direct = matchCommissionAd(content, opts);
  if (direct) return { action: 'delete', ...direct };

  // A guild running its own phrase list has opted out of everything built-in, patterns included;
  // the soft-sell tier is built-in too, so it stays off for them.
  const {
    softSell = usePatterns,
    deleteAt = SOFT_SELL_DELETE_AT,
    reviewAt = SOFT_SELL_REVIEW_AT,
    scoreBoost = 0,
  } = opts;
  if (!softSell) return null;

  const { score: baseScore, signals } = scoreSoftSell(content);
  if (baseScore === 0) return null;
  const score = baseScore + scoreBoost;

  // One signal is never enough, whatever it scored. 'money' alone is a price in conversation;
  // 'client-work' alone is someone mentioning their job. Corroboration is the point of the tier.
  if (signals.length < 2) return null;

  if (score >= deleteAt) return { action: 'delete', via: 'soft-sell', matched: signals.join('+'), score, signals };
  if (score >= reviewAt) return { action: 'review', via: 'soft-sell', matched: signals.join('+'), score, signals };
  return null;
}

export default {
  PHRASE_GROUPS, DEFAULT_PHRASES, PATTERN_RULES, SOFT_SELL_SIGNALS,
  SOFT_SELL_DELETE_AT, SOFT_SELL_REVIEW_AT,
  normalise, hasCommerceSignal, matchCommissionAd, scoreSoftSell, evaluateCommissionAd,
};
