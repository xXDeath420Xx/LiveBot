/*
 * Critters chat routing: one word table for `!owo <word> ...` (core/prefix-command-registry.js) and the natural
 * `owo<word>` prefix (core/critters-natural-prefix.js).
 *
 *   ALIASES      what a member may type -> the canonical word (`h` -> hunt, `lb` -> lootbox, `am` -> acceptmarriage)
 *   ROUTES       canonical word -> (parsed tokens) -> [action, args] for handlers/critters-actions.js
 *   chatArgs()   pulls the usual arguments out of the tokens: the first mention or 17-20 digit id is the target,
 *                the first 1-15 digit number is the amount (so an id is never read as an amount)
 *
 * Every command has a chat word, including the ones that used to be slash-only (ranch, forge, autohunt, luck ...).
 */
import { runAction } from './critters-actions.js';

const SNOWFLAKE = /^(?:<@!?(\d{15,25})>|(\d{17,20}))$/;
const NUMBER = /^\d{1,15}$/;

/** Arguments from the tokens after the command word. */
export function chatArgs(tokens = []) {
    const list = tokens.filter(Boolean);
    let target = null;
    for (const t of list) {
        const m = t.match(SNOWFLAKE);
        if (m) { target = m[1] || m[2]; break; }
    }
    const amountTok = list.find(t => NUMBER.test(t));
    const lower = list.map(t => t.toLowerCase());
    return {
        tokens: list,
        first: list[0] ?? null,
        second: list[1] ?? null,
        target,
        amount: amountTok != null ? Number(amountTok) : null,
        text: list.join(' '),
        all: lower.includes('all'),
        server: lower.includes('all') || lower.includes('server'),
    };
}

const lc = (v) => String(v ?? '').toLowerCase();
const without = (p, pred) => p.tokens.filter(t => !pred(t));
const BOARD_WORDS = { cookie: 'cookies', cookies: 'cookies', rep: 'cookies', luck: 'luck', pray: 'luck', curse: 'curse', curses: 'curse' };
const OFF_WORDS = new Set(['off', 'no', 'false', 'remove', 'unfavorite', 'unfavourite', '0']);

/* canonical word -> [action, args] */
export const ROUTES = Object.freeze({
    hunt: () => ['hunt', {}],
    zoo: (p) => ['zoo', { target: p.target }],
    leaderboard: (p) => (BOARD_WORDS[lc(p.first)] ? ['social-top', { kind: BOARD_WORDS[lc(p.first)] }] : ['leaderboard', {}]),
    catalog: () => ['catalog', {}],
    // `owo sell 3` sells ring 3; `owo sell rare` sells rare duplicates.
    sell: (p) => (/^\d+$/.test(p.first || '') ? ['ring-sell', { id: Number(p.first) }] : ['sell', { rank: p.first }]),
    sacrifice: (p) => ['sacrifice', { rank: p.first }],
    feed: (p) => ['feed', { animal: without(p, t => /^\d+$/.test(t)).join(' '), amount: [...p.tokens].reverse().find(t => NUMBER.test(t)) ?? null }],
    daily: () => ['daily', {}],
    balance: () => ['balance', {}],
    give: (p) => ['give', { target: p.target, amount: p.amount }],
    stats: (p) => ['stats', { target: p.target }],
    owoify: (p) => ['owoify', { text: p.text }],
    weapon: (p) => ['weapon', { id: p.amount }],
    crate: () => ['crate', {}],
    lootbox: (p) => ['lootbox', { count: p.all ? 'all' : (p.amount ?? 1) }],
    gems: () => ['gems', {}],
    use: (p) => ['use', { ids: p.text }],
    'grant-crate': (p) => ['grant-crate', { target: p.target, count: p.amount }],
    team: (p) => {
        const sub = lc(p.first);
        if (['add', 'remove', 'create', 'switch', 'rename', 'delete'].includes(sub)) return ROUTES[`team-${sub}`](chatArgs(p.tokens.slice(1)));
        if (sub === 'view') return ['team-view', { pgid: chatArgs(p.tokens.slice(1)).amount }];
        return ['team-view', { pgid: p.amount }];
    },
    'team-add': (p) => ['team-add', { animal: p.text }],
    'team-create': (p) => ['team-create', { name: p.text }],
    'team-remove': (p) => ['team-remove', { pos: p.amount }],
    'team-switch': (p) => ['team-switch', { pgid: p.amount }],
    'team-rename': (p) => ['team-rename', { pgid: p.first, name: p.tokens.slice(1).join(' ') }],
    'team-delete': (p) => ['team-delete', { pgid: p.amount }],
    equip: (p) => ['equip', { pos: p.first, uwid: p.second }],
    unequip: (p) => ['unequip', { pos: p.amount }],
    'pet-name': (p) => ['pet-name', { animal: p.first, nickname: p.tokens.slice(1).join(' ') }],
    battle: (p) => ['battle', { target: p.target, bet: p.amount }],
    duel: (p) => ['duel', { target: p.target, bet: p.amount }],
    ab: () => ['battle-answer', { answer: 'accept' }],
    db: () => ['battle-answer', { answer: 'decline' }],
    battlesetting: (p) => ['battle-settings', { text: p.tokens.map(t => t.replace(':', '=')).join(' ') }],
    boss: (p) => ['boss', { action: lc(p.first) || 'view' }],
    quest: (p) => {
        const f = lc(p.first);
        if (['claim-all', 'claimall', 'all'].includes(f)) return ['quest', { action: 'claim-all' }];
        if (/^[1-9]$/.test(f)) return ['quest', { slot: Number(f) }];
        if (f === 'claim' && /^[1-9]$/.test(lc(p.second))) return ['quest', { slot: Number(p.second) }];
        return ['quest', { action: 'view' }];
    },
    count: (p) => ['count', { target: p.target }],
    profile: (p) => {
        const sub = lc(p.first);
        const rest = p.tokens.slice(1);
        if (sub === 'about') return ['profile-about', { text: rest.join(' ') }];
        if (sub === 'title') return ['profile-title', { text: rest.join(' ') }];
        if (sub === 'accent' || sub === 'color' || sub === 'colour') return ['profile-accent', { color: rest[0], color2: rest[1] }];
        if (sub === 'private' || sub === 'privacy') return ['profile-privacy', { private: !OFF_WORDS.has(lc(rest[0])) }];
        if (sub === 'public') return ['profile-privacy', { private: false }];
        return ['profile-view', { target: p.target }];
    },
    pray: (p) => ['pray', { target: p.target }],
    curse: (p) => ['curse', { target: p.target }],
    cookie: (p) => ['cookie', { target: p.target }],
    lottery: (p) => ['lottery', { amount: p.amount, all: p.all }],
    drop: (p) => ['drop', { amount: p.amount }],
    pickup: (p) => ['pickup', { amount: p.amount }],
    limits: () => ['give-limits', {}],
    transactions: (p) => ['transactions', { target: p.target, server: p.server }],
    shop: () => ['shop', {}],
    buy: (p) => ['buy', { id: p.amount }],
    ring: (p) => {
        const sub = lc(p.first);
        if (sub === 'shop') return ['ring-shop', {}];
        if (sub === 'buy') return ['ring-buy', { id: p.amount }];
        if (sub === 'sell') return ['ring-sell', { id: p.amount }];
        return ['ring-inventory', {}];
    },
    wallpaper: (p) => {
        const sub = lc(p.first);
        if (sub === 'shop') return ['wallpaper-shop', { id: p.amount }];
        if (sub === 'buy') return ['wallpaper-buy', { id: p.amount }];
        if (sub === 'owned' || sub === 'list') return ['wallpaper-owned', {}];
        if (sub === 'equip') return ['wallpaper-equip', { id: p.second ?? '' }];
        if (sub === 'unequip') return ['wallpaper-unequip', {}];
        return ['wallpaper', { id: p.first ?? '' }];
    },
    marry: (p) => (p.target ? ['marry-propose', { target: p.target, ring: p.amount }] : ['marry-status', {}]),
    acceptmarriage: () => ['marry-accept', {}],
    declinemarriage: () => ['marry-decline', {}],
    divorce: () => ['marry-divorce', {}],
    ranch: (p) => (['claim', 'collect'].includes(lc(p.first)) ? ['ranch-claim', {}] : ['ranch', {}]),
    'ranch-claim': () => ['ranch-claim', {}],
    shards: () => ['shards', {}],
    dismantle: (p) => ['dismantle', { uwid: p.amount }],
    forge: (p) => ['forge', { rank: p.first }],
    favorite: (p) => ['favorite', { uwid: p.amount, favorite: !p.tokens.some(t => OFF_WORDS.has(lc(t)) && t !== String(p.amount)) }],
    'forge-prices': () => ['forge-prices', {}],
    autohunt: (p) => ['autohunt', { action: lc(p.first) || 'status' }],
    luck: () => ['luck', {}],
    help: () => ['help', {}],
});

/** alias -> canonical word. Each canonical word is also its own alias. */
const ALIAS_GROUPS = {
    hunt: ['hunt', 'h', 'catch'],
    zoo: ['zoo', 'z'],
    sell: ['sell'],
    sacrifice: ['sacrifice', 'sac', 'sc', 'essence', 'butcher'],
    feed: ['feed'],
    catalog: ['catalog', 'catalogue', 'owodex', 'od', 'dex', 'd'],
    battle: ['battle', 'b', 'fight'],
    duel: ['duel'],
    team: ['team', 'squad', 'tm'],
    'team-add': ['team-add', 'teamadd'],
    'team-create': ['team-create', 'teamcreate'],
    'team-remove': ['team-remove', 'teamremove'],
    'team-switch': ['team-switch', 'teamswitch'],
    'team-rename': ['team-rename', 'teamrename'],
    'team-delete': ['team-delete', 'teamdelete'],
    weapon: ['weapon', 'w', 'weapons', 'wep', 'inventory', 'inv'],
    equip: ['equip'],
    unequip: ['unequip'],
    'pet-name': ['pet-name', 'petname', 'nickname', 'nick'],
    crate: ['crate', 'weaponcrate', 'wc'],
    lootbox: ['lootbox', 'lb', 'lootboxes', 'box'],
    gems: ['gem', 'gems'],
    use: ['use'],
    'grant-crate': ['grant-crate', 'grantcrate'],
    ab: ['ab', 'acceptbattle'],
    db: ['db', 'declinebattle'],
    battlesetting: ['battlesetting', 'battlesettings', 'bs', 'battle-settings'],
    boss: ['boss', 'guildboss'],
    balance: ['balance', 'bal', 'money', 'cowoncy', 'currency', 'cash', 'credit', 'acorns'],
    daily: ['daily'],
    give: ['give', 'send', 'gift', 'trade', 'tr'],
    limits: ['limits', 'limit', 'givelimit', 'give-limits'],
    transactions: ['transactions', 'transaction', 'tx'],
    quest: ['quest', 'quests', 'q'],
    lottery: ['lottery', 'lotto', 'bet'],
    drop: ['drop'],
    pickup: ['pickup'],
    shop: ['shop', 'market'],
    buy: ['buy'],
    pray: ['pray'],
    curse: ['curse'],
    cookie: ['cookie', 'rep'],
    marry: ['marry', 'propose', 'marriage', 'wife', 'husband'],
    acceptmarriage: ['acceptmarriage', 'am'],
    declinemarriage: ['declinemarriage', 'dm'],
    divorce: ['divorce'],
    ring: ['ring', 'rings'],
    wallpaper: ['wallpaper', 'wallpapers', 'wp', 'background', 'backgrounds'],
    profile: ['profile'],
    stats: ['stats', 'me', 'my', 'level', 'lvl', 'levels', 'xp'],
    leaderboard: ['leaderboard', 'top', 'rank', 'ranking'],
    owoify: ['owoify', 'ify'],
    count: ['count', 'points', 'owocount'],
    ranch: ['ranch'],
    'ranch-claim': ['ranch-claim', 'ranchclaim'],
    shards: ['shards', 'shard'],
    dismantle: ['dismantle'],
    forge: ['forge'],
    favorite: ['favorite', 'favourite', 'fav'],
    'forge-prices': ['forge-prices', 'forgeprices'],
    autohunt: ['autohunt', 'ah'],
    luck: ['luck'],
    help: ['help', 'commands'],
};

export const ALIASES = new Map(Object.entries(ALIAS_GROUPS).flatMap(([word, list]) => list.map(a => [a, word])));

/** [action, args] for a canonical word and the tokens after it. */
export function routeWord(word, tokens = []) {
    const route = ROUTES[word];
    if (!route) return ['help', {}];
    return route(chatArgs(tokens));
}

/** The usage-tracking path (migration 433) a chat action stands for: "owo hunt", "owo team add", "owo2 marry accept". */
const OWO2_ACTIONS = new Set(['shards', 'dismantle', 'forge', 'favorite', 'forge-prices', 'ranch', 'ranch-claim', 'pray', 'curse', 'cookie',
    'lottery', 'drop', 'pickup', 'give-limits', 'transactions', 'duel', 'battle-settings', 'shop', 'feed']);
export function usagePathFor(action, args = {}) {
    const [head, ...tail] = action.split('-');
    const sub = tail.join('-');
    if (head === 'team' && sub) return `owo team ${sub}`;
    if (head === 'profile' && sub) return `owo-profile ${sub}`;
    if (['ring', 'wallpaper', 'marry'].includes(head) && sub) return `owo2 ${head} ${sub}`;
    if (action === 'wallpaper') return 'owo2 wallpaper equip';
    if (action === 'marry') return 'owo2 marry status';
    if (action === 'social-top') return 'owo2 top';
    if (action === 'buy') return 'owo2 shop';
    if (action === 'battle-answer') return 'owo battle';
    if (action === 'autohunt') return `autohunt ${args.action || 'status'}`;
    if (action === 'luck' || action === 'owoify') return action;
    if (OWO2_ACTIONS.has(action)) return `owo2 ${action}`;
    return `owo ${action}`;
}

/** The tokens after the command word of a `!owo ...` message (handles `!owo`, `! owo` and `@bot owo`). */
export function tokensAfterCommand(content, commandName = 'owo') {
    const parts = String(content || '').trim().split(/\s+/).filter(Boolean);
    let i = 0;
    if (/^<@!?\d+>$/.test(parts[0] || '')) i = 1;
    const word = (t) => String(t || '').toLowerCase().replace(/^[^a-z0-9]+/, '');
    if (word(parts[i]) === commandName) i += 1;
    else if (parts[i] && /^[^a-z0-9]+$/i.test(parts[i]) && word(parts[i + 1]) === commandName) i += 2;
    return parts.slice(i);
}

/* ----------------------------------------------------------------------------------------------- prefix registry entry points */

/** `!owo <word> ...`. No word means hunt; an unknown word shows the short help. */
export async function handleOwoRouter(ctx) {
    const tokens = tokensAfterCommand(ctx.message?.content, 'owo');
    if (!tokens.length) return runAction(ctx, 'hunt', {});
    const word = ALIASES.get(tokens[0].toLowerCase());
    if (!word) return runAction(ctx, 'help', {});
    const [action, args] = routeWord(word, tokens.slice(1));
    return runAction(ctx, action, args);
}

/** `!hunt`, `!catch`, `!h`. */
export async function handleHunt(ctx) {
    return runAction(ctx, 'hunt', {});
}

/** `!zoo [@user]`. */
export async function handleZoo(ctx) {
    return runAction(ctx, 'zoo', { target: ctx.options?.getUser?.('user') || ctx.options?.getString?.('user') || null });
}

/** `!owoify <text>`, `!uwuify <text>`. */
export async function handleOwoify(ctx) {
    return runAction(ctx, 'owoify', { text: ctx.options?.getString?.('text') || '' });
}
