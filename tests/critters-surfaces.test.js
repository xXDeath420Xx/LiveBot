import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The critters game's surfaces (spec docs/owo-cleanroom-spec.md section 11, routing and integration):
 *   - the natural `owo` prefix routes its aliases and stays silent on anything else
 *   - `!owo <word>` routes every word, including the ones that used to be slash-only
 *   - gates (game off, feature switch, game channels, blocked roles, admin-only) block before any game work,
 *     and a refused command never counts for the command quest
 *   - every spec command exists in the command files and the registration metadata
 *   - the dashboard router serves every spec 7.1 route at /guilds/:guildId/owo
 * No database: core/critters runs on a fake pool that answers config reads.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const critters = await import('../core/critters/index.js');
const { ACTIONS, runAction, RARE_LOG_TIERS } = await import('../handlers/critters-actions.js');
const prefix = await import('../handlers/critters-prefix.js');
const natural = await import('../core/critters-natural-prefix.js');

/* ----------------------------------------------------------------------------------------------- fake pool */

let configRow = null;
const queries = [];
function fakeQuery(sql, params) {
    queries.push(String(sql));
    if (/FROM `critter_config`/.test(sql)) return [configRow ? [configRow] : []];
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
    return [[]];
}
const fakePool = {
    async query(sql, params) { return fakeQuery(sql, params); },
    async execute(sql, params) { return fakeQuery(sql, params); },
    async getConnection() {
        return {
            query: async (sql, params) => fakeQuery(sql, params), execute: async (sql, params) => fakeQuery(sql, params),
            beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
        };
    },
};
critters.setCrittersPool(fakePool);

function setConfig(patch) {
    configRow = patch == null ? null : {
        enabled: 1, hunt_cooldown_seconds: 15, reward_currency_multiplier: 1, reward_xp_multiplier: 1, sell_multiplier: 0.5,
        sacrifice_xp_multiplier: 1, disabled_subcommands: '[]', allowed_channel_ids: '[]', blocked_role_ids: '[]', announce_rare_catches: 1, ...patch,
    };
    critters.invalidateConfig();
    queries.length = 0;
}

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const USER = '333333333333333333';

/** A stand-in for an interaction / MessageContextAdapter that records replies. */
function fakeIx({ admin = false, roles = [], channelId = CHANNEL, guildId = GUILD } = {}) {
    const replies = [];
    const ix = {
        guildId, channelId, id: '999', user: { id: USER, username: 'tester', bot: false },
        member: { roles: { cache: new Map(roles.map(r => [r, {}])) }, permissions: { has: () => admin } },
        memberPermissions: { has: () => admin },
        guild: { id: guildId, members: { cache: new Map() }, channels: { cache: new Map() } },
        client: { users: { cache: new Map() }, user: { id: '444444444444444444' } },
        channel: { id: channelId, send: async (p) => { replies.push(p); return { id: '1', edit: async () => {} }; } },
        replied: false, deferred: false,
        async reply(p) { this.replied = true; replies.push(p); return { id: '2', author: {}, channelId, edit: async () => {} }; },
        async followUp(p) { replies.push(p); return null; },
        async editReply(p) { replies.push(p); return null; },
        async fetchReply() { return null; },
        replies,
    };
    return ix;
}
const text = (r) => (typeof r === 'string' ? r : r?.content || '');

/* ----------------------------------------------------------------------------------------------- natural prefix */

test('natural prefix: hunt forms route to hunt; chatter and unknown words are silent', () => {
    for (const t of ['owoh', 'owo h', 'owo   hunt', 'OWO HUNT', 'owo catch']) assert.deepEqual(natural.resolveNatural(t), ['hunt', {}], t);
    for (const t of ['owo', 'owo that is cute', 'owo unknownword', 'owo owo', 'owo owoify', 'owo ify', 'hello owo', 'uwu']) {
        assert.equal(natural.resolveNatural(t), null, t);
    }
    assert.equal(natural.parseNatural('owo that is cute').point, true, 'chatter still earns a point');
    assert.equal(natural.parseNatural('hello there').point, false);
});

test('natural prefix: owoify, team folding, lootbox vs leaderboard, argument parsing', () => {
    assert.deepEqual(natural.resolveNatural('owo owo hello'), ['owoify', { text: 'hello' }]);
    assert.deepEqual(natural.resolveNatural('owo team add :fox:'), natural.resolveNatural('owo team-add :fox:'));
    assert.equal(natural.resolveNatural('owo team create Squad A')[0], 'team-create');
    assert.equal(natural.resolveNatural('owo team-rename 4 Night Owls')[1].name, 'Night Owls');
    assert.equal(natural.resolveNatural('owo lb')[0], 'lootbox');
    assert.equal(natural.resolveNatural('owo lb all')[1].count, 'all');
    assert.deepEqual(natural.resolveNatural('owo top'), ['leaderboard', {}]);
    assert.deepEqual(natural.resolveNatural('owo top cookie'), ['social-top', { kind: 'cookies' }]);
    assert.deepEqual(natural.resolveNatural('owo b <@123456789012345678> 500'), ['battle', { target: '123456789012345678', bet: 500 }]);
    assert.deepEqual(natural.resolveNatural('owo give 123456789012345678 25'), ['give', { target: '123456789012345678', amount: 25 }], 'a snowflake is never the amount');
    assert.deepEqual(natural.resolveNatural('owo sell 3'), ['ring-sell', { id: 3 }]);
    assert.deepEqual(natural.resolveNatural('owo sell rare'), ['sell', { rank: 'rare' }]);
    assert.deepEqual(natural.resolveNatural('owo buy 3'), ['buy', { id: 3 }]);
    assert.deepEqual(natural.resolveNatural('owo buy 203'), ['buy', { id: 203 }]);
    assert.deepEqual(natural.resolveNatural('owo quest 2'), ['quest', { slot: 2 }]);
    assert.deepEqual(natural.resolveNatural('owo bs display:compact speed=short'), ['battle-settings', { text: 'display=compact speed=short' }]);
});

test('natural prefix: every alias of spec 2.9 maps to its target word', () => {
    const SPEC = {
        hunt: ['hunt', 'h', 'catch'], zoo: ['zoo', 'z'], sell: ['sell'], sacrifice: ['sacrifice', 'sac', 'sc', 'essence', 'butcher'],
        catalog: ['catalog', 'catalogue', 'owodex', 'od', 'dex', 'd'], battle: ['battle', 'b', 'fight'], team: ['team', 'squad', 'tm'],
        'team-add': ['team-add', 'teamadd'], weapon: ['weapon', 'w', 'weapons', 'wep', 'inventory', 'inv'], equip: ['equip'],
        crate: ['crate', 'weaponcrate', 'wc'], lootbox: ['lootbox', 'lb', 'lootboxes', 'box'], gems: ['gem', 'gems'], use: ['use'],
        ab: ['ab', 'acceptbattle'], db: ['db', 'declinebattle'], battlesetting: ['battlesetting', 'battlesettings', 'bs'],
        balance: ['balance', 'bal', 'money', 'cowoncy', 'currency', 'cash', 'credit'], daily: ['daily'],
        give: ['give', 'send', 'gift', 'trade', 'tr'], limits: ['limits', 'limit', 'givelimit'], transactions: ['transactions', 'transaction'],
        quest: ['quest', 'quests', 'q'], lottery: ['lottery', 'lotto', 'bet'], drop: ['drop'], pickup: ['pickup'], shop: ['shop', 'market'], buy: ['buy'],
        pray: ['pray'], curse: ['curse'], cookie: ['cookie', 'rep'], marry: ['marry', 'propose', 'marriage', 'wife', 'husband'],
        acceptmarriage: ['acceptmarriage', 'am'], declinemarriage: ['declinemarriage', 'dm'], divorce: ['divorce'], ring: ['ring', 'rings'],
        wallpaper: ['wallpaper', 'wallpapers', 'wp', 'background', 'backgrounds'], profile: ['profile'],
        stats: ['stats', 'me', 'my', 'level', 'lvl', 'levels', 'xp'], leaderboard: ['leaderboard', 'top', 'rank', 'ranking'],
        owoify: ['owoify', 'ify'], count: ['count', 'points', 'owocount'], help: ['help', 'commands'],
    };
    for (const [target, aliases] of Object.entries(SPEC)) {
        for (const a of aliases) assert.equal(prefix.ALIASES.get(a), target, a);
    }
    // Words the legacy natural prefix lacked (spec 2.9 / defect 16) are reachable now.
    for (const w of ['boss', 'guildboss', 'grant-crate', 'tx', 'give-limits', 'battle-settings', 'team-create', 'team-remove', 'team-switch',
        'team-rename', 'team-delete', 'unequip', 'pet-name', 'ranch', 'ranch-claim', 'shards', 'dismantle', 'forge', 'favorite', 'forge-prices',
        'autohunt', 'luck', 'feed', 'duel']) {
        assert.ok(prefix.ALIASES.has(w), w);
    }
    assert.equal(natural._internals.PREFIX, 'owo');
    assert.ok(natural._internals.ALIASES instanceof Map);
    assert.equal(typeof natural._internals.buildArgs, 'function');
});

test('every route lands on a known action, and every action has a feature key (or is deliberately ungated)', () => {
    const keys = new Set(critters.FEATURE_KEYS);
    for (const word of new Set(prefix.ALIASES.values())) {
        const [action] = prefix.routeWord(word, ['1', '2']);
        assert.ok(ACTIONS[action], `${word} -> ${action}`);
    }
    for (const [name, def] of Object.entries(ACTIONS)) {
        const k = typeof def.key === 'function' ? def.key({ id: 1 }) : def.key;
        if (k != null) assert.ok(keys.has(k), `${name}: ${k}`);
        else assert.ok(['grant-crate', 'toggle', 'owoify', 'help'].includes(name), `${name} has no feature key`);
        assert.equal(typeof def.run, 'function', name);
    }
    for (const word of new Set(prefix.ALIASES.values())) {
        const [action, args] = prefix.routeWord(word, []);
        const p = prefix.usagePathFor(action, args);
        if (action === 'help') continue;
        assert.notEqual(critters.featureKeyForPath(p), undefined, `usage path ${p} (${word}) is a known path`);
    }
});

test('!owo router: reads the words after the command, defaults to hunt', () => {
    assert.deepEqual(prefix.tokensAfterCommand('!owo hunt now'), ['hunt', 'now']);
    assert.deepEqual(prefix.tokensAfterCommand('? owo zoo'), ['zoo']);
    assert.deepEqual(prefix.tokensAfterCommand('<@444444444444444444> owo daily'), ['daily']);
    assert.deepEqual(prefix.tokensAfterCommand('!owo'), []);
});

/* ----------------------------------------------------------------------------------------------- gates */

test('gates: no config row means off; every route refuses before any game work', async () => {
    setConfig(null);
    const ix = fakeIx();
    assert.equal(await runAction(ix, 'hunt', {}), 'refused');
    assert.match(text(ix.replies[0]), /not switched on/);
    assert.ok(!queries.some(q => /critter_(cooldowns|quests|owned)/.test(q)), 'no hunt or quest work ran');
    setConfig(null);
    const admin = fakeIx({ admin: true });
    await runAction(admin, 'zoo', {});
    assert.match(text(admin.replies[0]), /\/owo toggle/, 'admins are told how to switch it on');
});

test('gates: a switched-off feature blocks exactly its paths', async () => {
    setConfig({ disabled_subcommands: JSON.stringify(['hunt', 'marry']) });
    for (const action of ['hunt', 'marry-accept', 'marry', 'marry-status']) {
        const ix = fakeIx();
        assert.equal(await runAction(ix, action, {}), 'refused', action);
        assert.match(text(ix.replies[0]), /switched off/);
    }
    assert.ok(!queries.some(q => /critter_quests/.test(q)), 'refused commands never count for the command quest');
    const ix = fakeIx();
    await runAction(ix, 'balance', {});
    assert.ok(!/switched off/.test(text(ix.replies[0])), 'balance is not switched off');
    assert.ok(queries.some(q => /critter_quests/.test(q)), 'a command that passed its gates bumps the command quest');
});

test('gates: game channels and blocked roles apply to every command', async () => {
    const allowed = ['555555555555555555', '555555555555555556', '555555555555555557', '555555555555555558'];
    setConfig({ allowed_channel_ids: JSON.stringify(allowed) });
    for (const action of ['hunt', 'zoo', 'daily', 'profile-view']) {
        const ix = fakeIx();
        assert.equal(await runAction(ix, action, {}), 'refused', action);
        const t = text(ix.replies[0]);
        assert.equal((t.match(/<#\d+>/g) || []).length, 3, 'names at most three channels');
    }
    setConfig({ blocked_role_ids: JSON.stringify(['666666666666666666']) });
    const ix = fakeIx({ roles: ['666666666666666666'] });
    assert.equal(await runAction(ix, 'battle', {}), 'refused');
    assert.match(text(ix.replies[0]), /role/);
});

test('gates: toggle and grant-crate need Manage Server; toggle works while the game is off', async () => {
    setConfig(null);
    const member = fakeIx();
    assert.equal(await runAction(member, 'toggle', { enabled: true }), 'refused');
    assert.match(text(member.replies[0]), /Manage Server/);
    assert.equal(await runAction(fakeIx(), 'grant-crate', { target: '123456789012345678' }), 'refused');
    const admin = fakeIx({ admin: true });
    assert.equal(await runAction(admin, 'toggle', { enabled: true }), 'ran');
    assert.ok(queries.some(q => /INSERT INTO `critter_config`/.test(q)), 'toggle writes the config');
    assert.ok(!queries.some(q => /critter_quests/.test(q)), 'the toggle never counts for quests');
});

test('natural prefix handler: off means silent and no points; unknown words are silent', async () => {
    const replies = [];
    const message = (content) => ({
        content, guild: { id: GUILD, members: { cache: new Map() } }, guildId: GUILD, channelId: CHANNEL, id: '9',
        author: { id: USER, bot: false }, member: null, client: { user: { id: '444444444444444444' } },
        channel: { id: CHANNEL, send: async (p) => replies.push(p), sendTyping: async () => {} },
        reply: async (p) => { replies.push(p); return { id: '3', edit: async () => {} }; },
        mentions: { users: new Map() },
    });
    setConfig(null);
    assert.equal(await natural.handleOwoNaturalPrefix(message('owoh')), false);
    assert.ok(!queries.some(q => /points/.test(q)), 'no point while the game is off');
    setConfig({});
    assert.equal(await natural.handleOwoNaturalPrefix(message('owo that is cute')), false);
    assert.equal(replies.length, 0, 'no reply to chatter');
    assert.equal(await natural.handleOwoNaturalPrefix({ ...message('owoh'), author: { id: USER, bot: true } }), false, 'bots are ignored');
    assert.equal(await natural.handleOwoNaturalPrefix({ ...message('owoh'), guild: null }), false, 'DMs are ignored');
});

/* ----------------------------------------------------------------------------------------------- registration */

async function json(file) {
    return (await import(`../${file}`)).default.data.toJSON();
}
const leafNames = (j) => (j.options || []).flatMap(o => (o.type === 2 ? (o.options || []).map(s => `${o.name} ${s.name}`) : [o.name]));

test('every spec command exists with the member-facing names', async () => {
    const owo = await json('commands/fun/critters.js');
    assert.equal(owo.name, 'owo');
    assert.ok(owo.options.length <= 25);
    for (const p of ['hunt', 'zoo', 'leaderboard', 'catalog', 'sell', 'sacrifice', 'daily', 'balance', 'give', 'stats', 'weapon', 'crate', 'lootbox',
        'gems', 'use', 'grant-crate', 'team view', 'team create', 'team add', 'team remove', 'team switch', 'team rename', 'team delete', 'equip',
        'unequip', 'pet-name', 'battle', 'quest', 'boss', 'toggle', 'count']) {
        assert.ok(leafNames(owo).includes(p), `/owo ${p}`);
    }
    const owo2 = await json('commands/fun/critters-extra.js');
    assert.equal(owo2.name, 'owo2');
    assert.ok(owo2.options.length <= 23, 'room for the mounted profile and autohunt');
    for (const p of ['shards', 'dismantle', 'forge', 'favorite', 'forge-prices', 'ranch', 'ranch-claim', 'pray', 'curse', 'cookie', 'top', 'lottery',
        'drop', 'pickup', 'give-limits', 'transactions', 'duel', 'battle-settings', 'wallpaper shop', 'wallpaper buy', 'wallpaper equip',
        'wallpaper unequip', 'wallpaper owned', 'ring shop', 'ring buy', 'ring sell', 'ring inventory', 'marry propose', 'marry accept',
        'marry decline', 'marry divorce', 'marry status']) {
        assert.ok(leafNames(owo2).includes(p), `/owo2 ${p}`);
    }
    assert.deepEqual(leafNames(await json('commands/fun/critters-profile.js')), ['view', 'about', 'title', 'accent', 'privacy']);
    assert.deepEqual(leafNames(await json('commands/fun/critters-autohunt.js')), ['enable', 'disable', 'status', 'claim']);
    assert.equal((await json('commands/fun/critters-luck.js')).name, 'luck');
    const owoify = await json('commands/fun/owoify-text.js');
    assert.equal(owoify.name, 'owoify');
    assert.equal(owoify.options[0].max_length, 1800);
});

test('registration metadata points at the same names; the prefix registry points at the new router', async () => {
    const reg = await import('../core/command-registration.js');
    for (const n of ['owo', 'owo2', 'owo-profile', 'autohunt', 'owoify', 'luck']) assert.ok(reg.TEXT_COMMANDS.has(n), n);
    assert.equal(reg.TEXT_MERGE.owo2.into, 'owo');
    assert.equal(reg.TEXT_MERGE['owo-profile'].as, 'profile');
    assert.equal(reg.TEXT_ALIASES.hunt, 'owo hunt');
    const { MOUNTS } = await import('../core/command-mounts.js');
    assert.equal(MOUNTS.owoify.parent, 'fun');
    assert.equal(MOUNTS.luck.parent, 'fun');
    const registry = read('core/prefix-command-registry.js');
    assert.ok(!registry.includes('owo-prefix.js'));
    for (const m of ['handleOwoRouter', 'handleHunt', 'handleZoo', 'handleOwoify']) {
        assert.ok(registry.includes(`file: '../handlers/critters-prefix.js', method: '${m}'`), m);
        assert.equal(typeof prefix[m], 'function', m);
    }
});

test('the rare-catch log tiers are the module\'s auditable tiers; members are never told to type /owo2', () => {
    assert.deepEqual([...RARE_LOG_TIERS].sort(), [...critters.data.AUDITABLE_TIERS].sort());
    for (const f of ['handlers/critters-actions.js', 'handlers/critters-prefix.js', 'core/critters-natural-prefix.js',
        'commands/fun/critters.js', 'commands/fun/critters-extra.js', 'commands/fun/critters-profile.js', 'commands/fun/critters-autohunt.js']) {
        assert.ok(!/[`'"]\/owo2\b/.test(read(f)), `${f} tells members to type /owo2`);
    }
});

/* ----------------------------------------------------------------------------------------------- dashboard */

test('dashboard: every spec 7.1 route is served, mounted at /guilds/:guildId/owo', async () => {
    const router = (await import('../dashboard/routes/api/features/critters.js')).default;
    const routes = new Set(router.stack.filter(l => l.route).flatMap(l => Object.keys(l.route.methods).map(m => `${m.toUpperCase()} ${l.route.path}`)));
    for (const r of ['GET /config', 'PUT /config', 'GET /stats', 'GET /catalog', 'GET /commands', 'GET /user-zoo/:userId', 'POST /reset-user',
        'POST /reset-guild', 'POST /grant-animal', 'GET /user-full/:userId', 'POST /grant-shards', 'POST /grant-currency', 'POST /grant-crate',
        'GET /leaderboard/:kind', 'GET /module-snapshot']) {
        assert.ok(routes.has(r), r);
    }
    const index = read('dashboard/routes/api/index.js');
    assert.match(index, /import owoRoutes from '\.\/features\/critters\.js'/);
    assert.match(index, /router\.use\('\/guilds\/:guildId\/owo', owoRoutes\)/);
    const page = read('dashboard/views/partials/manage/critters.ejs');
    assert.ok(page.includes('/api/guilds/${guildId}/owo'), 'the page calls the same API');
    assert.match(page, /Game channels/);
    assert.match(page, /Blocked roles/);
    assert.ok(!/server economy currency|leveling XP payouts/i.test(page));
});

test('dashboard: malformed user ids and an unconfirmed server reset are 400s', async () => {
    const router = (await import('../dashboard/routes/api/features/critters.js')).default;
    const call = async (method, url, body = {}) => {
        const layer = router.stack.find(l => l.route && l.route.methods[method] && l.route.path.split('/')[1] === url.split('/')[1]);
        let status = 200; let payload = null;
        const params = { guildId: GUILD };
        if (layer.route.path.includes(':userId')) params.userId = url.split('/')[2];
        if (layer.route.path.includes(':kind')) params.kind = url.split('/')[2];
        const res = { status(c) { status = c; return this; }, json(p) { payload = p; return this; } };
        await layer.route.stack[0].handle({ params, body, user: { id: USER } }, res, () => {});
        return { status, payload };
    };
    setConfig({});
    assert.equal((await call('get', '/user-zoo/abc')).status, 400);
    assert.equal((await call('get', '/user-full/12')).status, 400);
    assert.equal((await call('post', '/reset-user', { userId: 'nope' })).status, 400);
    assert.equal((await call('post', '/grant-currency', { userId: USER, amount: 0 })).status, 400);
    queries.length = 0;
    assert.equal((await call('post', '/reset-guild', {})).status, 400);
    assert.ok(!queries.some(q => /DELETE/.test(q)), 'nothing is deleted without confirm: true');
    assert.equal((await call('get', '/leaderboard/nope')).status, 400);
});
