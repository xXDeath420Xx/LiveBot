/**
 * AI moderation evaluation — precision / recall of the message filters BEFORE and AFTER the AI moderation layer
 * on a labelled sample. Run from the repo root:
 *
 *   node scripts/ai-moderation-eval.mjs <dataDir> [--out results.json] [--no-ai]
 *
 * <dataDir> holds:
 *   candidates.json  real Discord messages from the DB (logged catches + random / keyword samples), see labels below
 *   evalset.json     real Twitch chat (2026-11-16 hand-labelled set) + labels.mjs (MUST / OPT, synthetic probes)
 *   discord-labels.json  optional {index: "category"|"neg"|"skip"} corrections after manual review
 * Synthetic scam / evasion / benign cases are generated here and never posted anywhere.
 *
 * BEFORE = the detectors that act on a text message at post time today: the phishing domain feeds (exact host or
 *          parent), the commission-ad matcher, the obfuscated-URL "fake support" detector (confirmed), and the
 *          KumaBot Defender spam templates.
 * AFTER  = BEFORE plus the new layer: folding + cheap signals + link names, and a local model only when the
 *          cheap score is ambiguous (core/ai-moderation.js classify; Gemini is never used here, so no member text
 *          from the real sample leaves the owner's hardware).
 * A prediction counts as correct when it flags a positive item (any category). Per-category recall is also given.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import pool from '../utils/db.js';
import L from '../core/ai-moderation-logic.js';
import LI from '../core/link-intel-logic.js';
import ai from '../core/ai-moderation.js';
import { extractLinks } from '../core/link-policy.js';
import { matchCommissionAd } from '../core/commission-spam-match.js';
import { analyzeMessage } from '../core/obfuscated-url.js';
import { isSpam as kbdSpam } from '../core/twitch-kbd-defender.js';

const dataDir = process.argv[2];
const outFile = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
const noAi = process.argv.includes('--no-ai');
const noSemantic = process.argv.includes('--no-semantic');
if (!dataDir) { console.error('usage: node scripts/ai-moderation-eval.mjs <dataDir> [--out file] [--no-ai]'); process.exit(2); }

// ── the sample ───────────────────────────────────────────────────────────────

const items = [];
const add = (group, text, label, src) => items.push({ group, text: String(text), label, src });

// Real Discord: logged catches and random / keyword-heavy everyday messages.
const cand = JSON.parse(fs.readFileSync(path.join(dataDir, 'candidates.json'), 'utf8'));
const corrections = fs.existsSync(path.join(dataDir, 'discord-labels.json')) ? JSON.parse(fs.readFileSync(path.join(dataDir, 'discord-labels.json'), 'utf8')) : {};
const seen = new Set();
cand.forEach((c, i) => {
    const key = c.t.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    let label = corrections[i];
    if (!label) {
        if (c.src.startsWith('commission:confirmed')) label = 'spam_bot';
        else if (c.src === 'cross_channel') label = /girl|cam|e-?girl|pretty|cute/i.test(c.t) ? 'sexual' : 'skip';
        else if (c.src === 'deleted_by_banned') label = /give out my pc/i.test(c.t) ? 'scam' : 'neg';
        else label = 'neg';
    }
    if (label === 'skip') return;
    add('discord_real', c.t, label, `${c.src}#${i}`);
});

// Real Twitch chat (hand-labelled 2026-11-16) and its synthetic probes.
const evalset = JSON.parse(fs.readFileSync(path.join(dataDir, 'evalset.json'), 'utf8'));
const { realLabels, SYNTH } = await import(pathToFileURL(path.join(dataDir, 'labels.mjs')).href);
const tl = realLabels(evalset.length).mod;
evalset.forEach((e, i) => { if (tl[i] !== 'opt') add('twitch_real', e.t, tl[i] === 'must' ? 'harassment' : 'neg', `evalset#${i}`); });
for (const [t, , m] of SYNTH) add('twitch_probe', t, m === 'must' ? (/followers|viewers/.test(t) ? 'spam_bot' : /nudes/.test(t) ? 'sexual' : 'harassment') : 'neg', 'labels.mjs SYNTH');

// Synthetic scams and the disguises scammers use (never posted).
const BASE = [
    ['scam', 'Hey, your account was flagged for suspicious activity. Open a ticket with Discord support here: discord.gg/support-appeal'],
    ['scam', 'free discord nitro for 3 months, claim before it expires: https://discord-nitro-gift.com/claim'],
    ['scam', 'I accidentally reported you, please contact the moderator at steamcommunlty.com/id/mod to fix it'],
    ['scam', 'bro is this you in this video?? https://dlscord.gg/v1d3o'],
    ['scam', 'Got a free $50 steam gift card from steamgift.top, use code WIN50, hurry it expires tonight'],
    ['scam', 'Giving away my old gaming PC, just pay the shipping, DM me fast'],
    ['scam', 'Looking for testers for my new game, you get paid $25 an hour, download it from bit.ly/game-test'],
    ['crypto_fraud', 'Elon is doubling all BTC sent this week only, send 0.1 btc to receive 0.2 back: musk-giveaway.live'],
    ['crypto_fraud', 'Connect your wallet to claim the airdrop before it ends: metamask-airdrop.xyz'],
    ['crypto_fraud', 'I made $4000 this week with my crypto trading mentor, dm me and I will connect you'],
    ['crypto_fraud', 'your wallet needs verification, enter your seed phrase at wallet-sync.app'],
    ['harassment', 'kys nobody wants you here'],
    ['harassment', 'you are a worthless retard, get out of the server'],
    ['harassment', 'I know where you live, see you soon'],
    ['harassment', 'go back to your country, nobody wants your kind here'],
    ['harassment', 'shut up you stupid bitch, no one asked'],
    ['sexual', 'omg join girl in cam discord.gg/camgirls-live'],
    ['sexual', 'hot singles in your area waiting for you, click my bio'],
    ['sexual', 'leaked onlyfans of her, free link in my profile'],
    ['self_harm', 'i want to kill myself, nothing matters anymore'],
    ['self_harm', 'honestly i am better off dead, going to end it tonight'],
    ['spam_bot', 'buy cheap followers and viewers at bigfollows dot shop'],
    ['spam_bot', 'best viewbot 100% safe and undetected, dm me for prices'],
    ['raid', 'everyone raid this server at 9pm and spam the chat: discord.gg/target'],
    ['raid', 'mass report this account guys, lets get it banned'],
    ['impersonation', 'This is Discord Trust & Safety. Your account will be terminated unless you verify at discord-verify.com'],
    ['impersonation', 'I am a Discord staff member, send me the login code you just received to keep your account'],
    ['malicious_link', 'check this out grabify.link/ABCD12'],
    ['malicious_link', 'log in again here https://discord.com@evil-login.ru/login'],
];
const CYR = { a: 'а', e: 'е', o: 'о', c: 'с', p: 'р', x: 'х', i: 'і', s: 'ѕ' };
const homoglyph = (t) => t.replace(/[aeocpxis]/g, (ch, i) => (i % 2 ? CYR[ch] : ch));
const zeroWidth = (t) => t.replace(/(\w{3})(\w)/g, '$1​$2');
const leet = (t) => t.replace(/[aeios]/g, ch => ({ a: '4', e: '3', i: '1', o: '0', s: '5' })[ch]);
const spaced = (t) => t.split(' ').map((w, i) => (i % 3 === 1 && w.length > 3 && !/[./:]/.test(w) ? w.split('').join(' ') : w)).join(' ');
const repeats = (t) => t.replace(/([aeiou])/g, (m, v, i) => (i % 7 === 0 ? v.repeat(4) : v));
const TRANSFORMS = { plain: t => t, homoglyph, zero_width: zeroWidth, leet, spacing: spaced, repeats, mixed: t => zeroWidth(homoglyph(t)) };
for (const [cat, t] of BASE) for (const [name, fn] of Object.entries(TRANSFORMS)) add('synthetic_evasion', fn(t), cat, `synthetic:${name}`);

// Synthetic look-alikes of trouble that are fine (the false-positive traps).
const BENIGN = [
    "Heads up: someone is DMing people a fake nitro link, don't click it, it's a scam",
    'is discord-nitro-gift.com legit? looks like a scam to me',
    'I got Nitro for my birthday from my brother, so happy',
    "I'm gonna kill this boss tonight", 'that headshot was straight murder lol', "she's a killer on the sticks fr",
    'die already you stupid zombie LUL', 'check out my clip https://www.twitch.tv/somestreamer/clip/AbcDef',
    'the steam sale starts tomorrow, wishlist stuff at store.steampowered.com', 'I sold my old PC on ebay last week',
    "can someone help me verify my account? the verification bot isn't working", 'my suicide squad review is up on youtube',
    'that movie made me want to die laughing', "Raid incoming! We're raiding Sarah after stream, thanks for watching",
    'Free giveaway in #giveaways, react to enter, ends Friday', 'I invested in bitcoin back in 2017 lol',
    'Привет всем, как дела сегодня?', 'reminder: never share your seed phrase with anyone, staff will never ask for it',
    'the new discord update moved the settings button again', 'gg wp everyone, see you next stream',
    'who wants to join the vc? discord.gg/abc is our main server', 'my cat just knocked my coffee over',
    'Report scams to the mods, don\'t engage with them', 'this boss is so stupid it keeps getting stuck lmao',
    'fr33 kill on that guy lol', 'can I DM you about the commission you posted last week?',
];
for (const t of BENIGN) add('synthetic_benign', t, 'neg', 'synthetic:benign');

// Held-out synthetic cases (written after the dev run, never used for tuning): dataDir/heldout.json.
if (fs.existsSync(path.join(dataDir, 'heldout.json'))) {
    const h = JSON.parse(fs.readFileSync(path.join(dataDir, 'heldout.json'), 'utf8'));
    for (const [cat, t] of h.pos) add('heldout', t, cat, 'heldout:pos');
    for (const t of h.neg) add('heldout', t, 'neg', 'heldout:neg');
}
// A second held-out set, written after the broad cues were added and scored once without further tuning.
if (fs.existsSync(path.join(dataDir, 'heldout2.json'))) {
    const h = JSON.parse(fs.readFileSync(path.join(dataDir, 'heldout2.json'), 'utf8'));
    for (const [cat, t] of h.pos) add('heldout2', t, cat, 'heldout2:pos');
    for (const t of h.neg) add('heldout2', t, 'neg', 'heldout2:neg');
}
// A third, written before the semantic gate's prototypes and threshold existed.
if (fs.existsSync(path.join(dataDir, 'heldout3.json'))) {
    const h = JSON.parse(fs.readFileSync(path.join(dataDir, 'heldout3.json'), 'utf8'));
    for (const [cat, t] of h.pos) add('heldout3', t, cat, 'heldout3:pos');
    for (const t of h.neg) add('heldout3', t, 'neg', 'heldout3:neg');
}

// ── detectors ────────────────────────────────────────────────────────────────

console.error(`[eval] ${items.length} items; loading the phishing feed…`);
const [rows] = await pool.query('SELECT domain FROM phishing_domains');
const feed = new Set(rows.map(r => r.domain));
const listed = (h) => { const p = h.split('.'); for (let i = 0; i < p.length - 1; i++) if (feed.has(p.slice(i).join('.'))) return true; return false; };

function before(text) {
    const why = [];
    for (const l of extractLinks(text)) if (listed(l.host)) why.push('phishing_feed');
    if (matchCommissionAd(text)) why.push('commission');
    if (analyzeMessage(text)?.verdict === 'confirmed') why.push('obfuscated_url');
    if (kbdSpam(text)) why.push('kbd_template');
    return { flagged: why.length > 0, why };
}

async function after(text, platform) {
    const n = L.normalise(text);
    const { signals } = L.textSignals(n, { targeted: /@\w|<@/.test(text) });
    const links = LI.linkSignalsBest([n.plain, ...n.forms]);
    signals.push(...links.signals);
    for (const h of links.hosts) if (listed(h.host)) signals.push({ id: 'link_phishing_listed', points: 10, category: 'malicious_link' });
    const a = analyzeMessage(text);
    if (a?.verdict === 'confirmed' || a?.verdict === 'suspicious') signals.push({ id: 'obfuscated_link', points: 4, category: 'scam' });
    for (const code of LI.extractInviteCodes(`${n.plain}\n${n.folded}`)) signals.push(...LI.inviteSignals(code, null));
    let score = L.weightedScore(signals);
    const lexicalScore = score;
    // The semantic gate (same code as the live stage); sims are kept for calibration on the dev groups.
    const sims = noSemantic ? null : await ai.semanticFor(n, L.contentKey(text));
    if (sims && score < L.AMBIGUOUS_MIN) { signals.push(...L.semanticSignals(sims)); score = L.weightedScore(signals); }
    const b = L.band(score, signals);
    if (b === 'clean' || noAi) return { flagged: false, band: b, score, lexicalScore, sims, ai: null, signals: signals.map(s => s.id), hinted: b !== 'clean' ? L.hintedCategory(signals) : null };
    const r = await ai.classify('eval', { text, signals, score, platform, cloudAllowed: false, dailyCap: 1e9 });
    const d = L.decideAction({ classification: r.classification, score, signals, config: L.configFrom({ enabled: 1 }) });
    return { flagged: d.catch, category: d.category, band: b, score, lexicalScore, sims, ai: { status: r.status, model: r.model, tier: r.tier, ms: r.ms, labels: r.classification?.labels, reason: r.classification?.reason }, signals: signals.map(s => s.id) };
}

// ── run ──────────────────────────────────────────────────────────────────────

const results = [];
let i = 0;
for (const it of items) {
    const b = before(it.text);
    const a = await after(it.text, it.group.startsWith('twitch') ? 'twitch' : 'discord');
    results.push({ ...it, before: b, after: { ...a, flagged: b.flagged || a.flagged, newFlag: a.flagged } });
    if (++i % 50 === 0) console.error(`[eval] ${i}/${items.length}`);
}

const pos = (r) => r.label !== 'neg';
function metrics(list, key) {
    return L.precisionRecall(list.map(r => ({ predicted: r[key].flagged, actual: pos(r) })));
}
const groups = ['all', ...new Set(results.map(r => r.group))];
const summary = {};
for (const g of groups) {
    const list = g === 'all' ? results : results.filter(r => r.group === g);
    summary[g] = { n: list.length, positives: list.filter(pos).length, before: metrics(list, 'before'), after: metrics(list, 'after') };
}
const byCategory = {};
for (const c of L.CATEGORIES) {
    const list = results.filter(r => r.label === c);
    if (!list.length) continue;
    byCategory[c] = { n: list.length, recallBefore: Number((list.filter(r => r.before.flagged).length / list.length).toFixed(3)), recallAfter: Number((list.filter(r => r.after.flagged).length / list.length).toFixed(3)) };
}
const byTransform = {};
for (const r of results.filter(x => x.group === 'synthetic_evasion')) {
    const t = r.src.split(':')[1];
    const o = byTransform[t] || (byTransform[t] = { n: 0, before: 0, after: 0 });
    o.n++; if (r.before.flagged) o.before++; if (r.after.flagged) o.after++;
}
const negs = results.filter(r => !pos(r));
const aiCalls = results.filter(r => r.after.ai && r.after.ai.status !== 'cached');
const lat = aiCalls.map(r => r.after.ai.ms).filter(Number.isFinite).sort((x, y) => x - y);
const usage = {
    aiAskedShare: Number((results.filter(r => r.after.ai).length / results.length).toFixed(3)),
    aiAskedShareOnNegatives: Number((negs.filter(r => r.after.ai).length / negs.length).toFixed(3)),
    aiAskedShareOnRealNegatives: Number((negs.filter(r => r.after.ai && /real/.test(r.group)).length / Math.max(1, negs.filter(r => /real/.test(r.group)).length)).toFixed(3)),
    tiers: aiCalls.reduce((a, r) => ((a[`${r.after.ai.tier}:${r.after.ai.model}`] = (a[`${r.after.ai.tier}:${r.after.ai.model}`] || 0) + 1), a), {}),
    noVerdict: results.filter(r => r.after.ai && r.after.ai.status !== 'ok' && r.after.ai.status !== 'cached').length,
    latencyMs: lat.length ? { p50: lat[Math.floor(lat.length * 0.5)], p90: lat[Math.floor(lat.length * 0.9)], max: lat[lat.length - 1] } : null,
};
const errors = {
    falsePositivesAfter: results.filter(r => !pos(r) && r.after.flagged).map(r => ({ group: r.group, src: r.src, text: r.text.slice(0, 160), why: r.before.why.length ? r.before.why : r.after.category, reason: r.after.ai?.reason })),
    missesAfter: results.filter(r => pos(r) && !r.after.flagged).map(r => ({ group: r.group, src: r.src, label: r.label, text: r.text.slice(0, 160), score: r.after.score, band: r.after.band, ai: r.after.ai?.labels })),
};
const out = { at: new Date().toISOString(), items: results.length, summary, byCategory, byTransform, usage, errors };
console.log(JSON.stringify({ summary, byCategory, byTransform, usage }, null, 1));
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ ...out, results }, null, 1));
await pool.end();
process.exit(0);
