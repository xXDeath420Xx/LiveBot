/*
 * Small invented Firebot and Streamer.bot files for the import tests (tests/stream-bot-import*.test.js), and a
 * tiny ZIP writer. Every name, id and "secret" here is made up; the fake secrets have the shapes the strip and
 * scan rules look for, so a test fails if one survives.
 */
import zlib from 'node:zlib';

export const FAKE = Object.freeze({
    oauth: 'oauth:abcdefghijklmnopqrstu1234567890',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXBsZWhvbGxvdyJ9.c2lnbmF0dXJlLWZha2UtMTIz',
    webhook: 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    refresh: 'r3fr3shT0k3nMapleHollow00000000000000000000',
    obsPassword: 'MapleObsPassw0rd!',
});

// ── Firebot profile ──────────────────────────────────────────────────────────────────────────
export const firebotProfile = () => ({
    'chat/commands.json': {
        customCommands: {
            c1: { id: 'c1', trigger: '!socials', active: true, aliases: ['!links'], cooldown: { global: 30 }, count: 12,
                effects: { list: [{ id: 'e1', type: 'firebot:chat', message: 'Find $user on maplehollow.example', active: true }] }, restrictionData: { restrictions: [] } },
            c2: { id: 'c2', trigger: '!death', active: true, cooldown: {}, restrictionData: { restrictions: [{ type: 'firebot:permissions', mode: 'roles', roleIds: ['broadcaster', 'mod'] }] },
                effects: { list: [{ id: 'e2', type: 'firebot:update-counter', counterId: 'k1', mode: 'increment', value: 1, active: true },
                    { id: 'e3', type: 'firebot:chat', message: 'Deaths: $counter[Deaths]', active: true }] } },
            c3: { id: 'c3', trigger: '!hug', active: true, cooldown: { user: 10 }, restrictionData: { restrictions: [{ type: 'firebot:permissions', mode: 'roles', roleIds: ['vip'] }] },
                effects: { list: [{ id: 'e4', type: 'firebot:chat', message: '$user hugs $arg[1] ($randomNumber[1,10]/10)', active: true }] } },
            c4: { id: 'c4', trigger: '!clip', active: true, cooldown: {}, restrictionData: { restrictions: [] },
                effects: { list: [{ id: 'e5', type: 'firebot:clip' }, { id: 'e6', type: 'firebot:chat', message: 'Clipped!' }] } },
            c5: { id: 'c5', trigger: '!alert', active: false, cooldown: {}, restrictionData: { restrictions: [] },
                effects: { list: [{ id: 'e7', type: 'firebot:playsound', filepath: 'C:\\Users\\maple\\Sounds\\airhorn.mp3', volume: 7 },
                    { id: 'e8', type: 'firebot:discord', webhookUrl: FAKE.webhook, message: 'hi' },
                    { id: 'e9', type: 'firebot:http-request', method: 'POST', url: 'https://hooks.maplehollow.example/x', body: '{"u":"$user"}', headers: [{ key: 'Authorization', value: `Bearer ${FAKE.refresh}` }] }] } },
            c6: { id: 'c6', trigger: '!so', active: true, cooldown: {}, effects: { list: [{ type: 'firebot:chat', message: 'Go follow $target' }] } },
        },
    },
    'events/events.json': {
        mainEvents: [
            { id: 'v1', name: 'Thank cheers', sourceId: 'twitch', eventId: 'cheer', active: true, filterData: { mode: 'exclusive', filters: [] },
                effects: { list: [{ type: 'firebot:chat', message: 'Thanks $user for $cheerBitsAmount bits' }] } },
            { id: 'v2', name: 'Spam words', sourceId: 'twitch', eventId: 'chat-message', active: true,
                filterData: { mode: 'inclusive', filters: [{ type: 'firebot:message-text', comparisonType: 'contains', value: 'cheap viewers' }, { type: 'firebot:message-text', comparisonType: 'contains', value: 'buy followers' }] },
                effects: { list: [{ type: 'firebot:delete-chat-message' }] } },
            { id: 'v3', name: 'Arrivals', sourceId: 'twitch', eventId: 'viewer-arrived', active: true, effects: { list: [{ type: 'firebot:chat', message: 'hi' }] } },
            { id: 'v4', name: 'Scene sounds', sourceId: 'twitch', eventId: 'follow', active: true, effects: { list: [
                { type: 'firebot:obs-change-scene', sceneName: 'Thanks' },
                { type: 'firebot:randomeffect', effectList: { list: [{ type: 'firebot:chat', message: 'Welcome!' }, { type: 'firebot:chat', message: 'Hello!' }] } },
                { type: 'firebot:showImage', file: 'C:\\Users\\maple\\Pictures\\leaf.png', position: 'Top Right', length: 4, width: 250, enterAnimation: 'zoomIn' }] } },
        ],
        groups: {},
    },
    'timers.json': {
        t1: { id: 't1', name: 'Discord', active: true, interval: 900, requiredChatLines: 0, onlyWhenLive: false, effects: { list: [{ type: 'firebot:chat', message: 'Join the grove on Discord' }] } },
        t3: { id: 't3', name: 'Deaths display', active: false, interval: 1.1, effects: { list: [{ type: 'firebot:showtext', position: 'Custom', enterAnimation: 'fadeIn',
            text: '<p><span style="font-size: 80px; color: red">Deaths:&nbsp;$counter[Deaths]</span></p>' }] } },
        t2: { id: 't2', name: 'Dice', active: true, interval: 600, effects: { list: [{ type: 'firebot:chat', message: 'You rolled $randomNumber[1,6]' }] } },
    },
    'counters/counters.json': { k1: { id: 'k1', name: 'Deaths', value: 7, updateEffects: { list: [{ type: 'firebot:announcement', color: 'Purple', message: 'Deaths: $counter[Deaths]' }] } } },
    'channel-rewards.json': {
        r1: { id: 'r1', manageable: true, twitchData: { id: 'r1', title: 'Hydrate', cost: 300, prompt: 'Drink water', isEnabled: true, backgroundColor: '#00AAFF' },
            effects: { list: [{ type: 'firebot:chat', message: '$user says drink up' }] } },
    },
    'power-ups.json': { p1: { id: 'p1', twitchData: { id: 'p1', title: 'Confetti', bits: 500, isEnabled: true } } },
    'chat/moderation/banned-words.json': { words: [{ text: 'mapleword' }] },
    'chat/moderation/chat-moderation-settings.json': { bannedWordList: { enabled: true }, urlModeration: { enabled: false }, emoteLimit: { enabled: false } },
    'integrations.json': { OBS: { userSettings: { websocketSettings: { ipAddress: '127.0.0.1', port: 4455, password: FAKE.obsPassword } } }, streamelements: { accountId: 'abcdef0123456789abcdef01', linked: true } },
    'auth-twitch.json': { streamer: { auth: { access_token: FAKE.oauth, refresh_token: FAKE.refresh } } },
    'db/users.db': [
        { _id: '700000101', username: 'maplefan_88', minutesInChannel: 1200, chatMessages: 340 },
        { _id: '700000102', username: 'bramble', minutesInChannel: 15, chatMessages: 0 },
    ],
});

export function firebotFiles(over = {}) {
    const m = new Map();
    for (const [p, v] of Object.entries({ ...firebotProfile(), ...over })) {
        if (v == null) continue;
        m.set(p, Buffer.from(p.endsWith('users.db') ? v.map((x) => JSON.stringify(x)).join('\n') : JSON.stringify(v)));
    }
    return m;
}

export const firebotSetup = () => ({
    name: 'Maple setup', version: '5.67.0',
    components: { commands: [firebotProfile()['chat/commands.json'].customCommands.c1], events: [], timers: [], counters: [] },
});

// ── Streamer.bot data folder ─────────────────────────────────────────────────────────────────
export const streamerbotData = () => ({
    'actions.json': {
        version: 24, actions: [
            { id: 'a1', name: 'Scene: Gaming', group: 'Scenes', enabled: true, triggers: [{ id: 't1', type: 302, commandId: 's1', enabled: true }],
                subActions: [{ id: 'x1', type: 34, sceneName: 'Gaming', index: 0, enabled: true }, { id: 'x2', type: 413, sceneName: 'Gaming', sourceName: 'Mic', state: 1, index: 1, enabled: true },
                    { id: 'x2b', type: 42, sceneName: 'Gaming', sourceName: 'Discord', state: 0, index: 1, enabled: true }, { id: 'x2c', type: 401, sceneName: 'Gaming', sourceName: 'Cam', state: 1, index: 1, enabled: true },
                    { id: 'x3', type: 1009, value: 'a comment', index: 2, enabled: true }] },
            { id: 'a2', name: 'Lurk', group: 'Chat', enabled: true, triggers: [{ id: 't2', type: 401, commandId: 'c1', enabled: true }],
                subActions: [{ id: 'x4', type: 10, text: '%user% is lurking', index: 0, enabled: true }] },
            { id: 'a3', name: 'Song code', group: 'Music', enabled: true, triggers: [{ id: 't3', type: 401, commandId: 'c2', enabled: true }],
                subActions: [{ id: 'x5', type: 99999, byteCode: 'TVqQAAMAAAAEAAAA//8AALgAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAA', references: [] }] },
            { id: 'a4', name: 'Thanks follow', enabled: true, triggers: [{ id: 't4', type: 101, enabled: true }],
                subActions: [{ id: 'x6', type: 99900, random: true, name: 'pick', index: 0, enabled: true, subActions: [
                    { id: 'x7', type: 10, text: 'Thanks %user%!', index: 0 }, { id: 'x8', type: 10, text: 'Welcome %user%!', index: 1 }] }] },
            { id: 'a5', name: 'Run lurk', enabled: true, triggers: [{ id: 't5', type: 702, enabled: true }], subActions: [{ id: 'x9', type: 10, text: 'hi', index: 0 }] },
            { id: 'a8', name: '[SPOTIFY & SB] 6 - Skip Song', group: 'SPOTIFY & SB', enabled: true, triggers: [{ id: 't8', type: 401, commandId: 'c3', enabled: true }],
                subActions: [{ id: 'x13', type: 99998, executeCodeId: 'e0d9db7b-0b65-425e-acd9-055fb8f60021', method: 'SkipSong', index: 0 }] },
            { id: 'a9', name: '[SPOTIFY & SB] [#] 1 - Authorization', group: 'SPOTIFY & SB', enabled: true, triggers: [],
                subActions: [{ id: 'x14', type: 99999, byteCode: 'AAAA', references: [] }] },
            { id: 'a7', name: 'Confetti thanks', enabled: true, triggers: [{ id: 't7', type: 496, customPowerUpId: 'p1', enabled: true }],
                subActions: [{ id: 'x12', type: 23, text: 'Confetti for %user%!', color: 4, index: 0 }] },
            { id: 'a6', name: 'Mystery', enabled: true, triggers: [{ id: 't6', type: 112, rewardId: 'rw1', enabled: true }],
                subActions: [{ id: 'x10', type: 777, foo: 1, index: 0 }, { id: 'x11', type: 10, text: '!lurk', index: 1 }] },
        ],
    },
    'commands.json': { version: 7, commands: [
        { id: 'c1', name: 'Lurk', command: '!lurk\r\n!afk', enabled: true, mode: 0, location: 0, sources: 1, globalCooldown: 5, userCooldown: 0, permittedGroups: [] },
        { id: 'c2', name: 'Song', command: '!song', enabled: true, mode: 0, location: 0, sources: 1, permittedGroups: ['Moderators'] },
        { id: 'c3', name: '[SPOTIFY & SB] Skip Song', group: 'SPOTIFY & SB', command: '!skip\r\n!next', enabled: true, mode: 0, location: 0, sources: 1, permittedGroups: [] },
    ] },
    'twitch_rewards.json': { version: 3, rewards: [{ id: 'rw1', title: 'Mystery box', cost: 1000, prompt: 'Open it', userInput: false, backgroundColor: '#AA00FF' }], autoRewards: [] },
    'quotes.dat': { version: 0, quotes: [{ id: 1, quote: 'The grove remembers', userName: 'maplefan_88' }] },
    'users.dat': { version: 11, users: [{ id: '700000101', name: 'maplefan_88', type: 'twitch', role: 1 }] },
    'settings.json': { speechToText: { commands: [{ id: 's1', enabled: true, command: 'Lets play a game' }] }, timedActions: { timers: [] },
        websockets: { autoStart: true, authPassword: FAKE.obsPassword }, twitch: { autoConnect: true }, lumiaStream: { socketToken: FAKE.refresh } },
    'obs.json': { connections: [{ id: 'o1', name: 'OBS', host: '127.0.0.1', port: 4455, password: FAKE.obsPassword, default: true }] },
    'auth.db': 'not a real database',
    'globals.db': 'not a real database',
});

export function streamerbotFiles(over = {}) {
    const m = new Map();
    for (const [p, v] of Object.entries({ ...streamerbotData(), ...over })) {
        if (v == null) continue;
        m.set(p, Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
    }
    return m;
}

/** A Streamer.bot import string: base64("SBAE" + gzip(JSON)). */
export function sbImportString(obj) {
    return Buffer.concat([Buffer.from('SBAE'), zlib.gzipSync(Buffer.from(JSON.stringify(obj)))]).toString('base64');
}

// ── a minimal ZIP writer (stored and deflated entries) ───────────────────────────────────────
export function makeZip(entries, { deflate = true, prefix = '' } = {}) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name0, data0] of entries) {
        const name = Buffer.from(prefix + name0, 'utf8');
        const data = Buffer.isBuffer(data0) ? data0 : Buffer.from(String(data0));
        const comp = deflate ? zlib.deflateRawSync(data) : data;
        const crc = zlib.crc32(data);
        const method = deflate ? 8 : 0;
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
        lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
        locals.push(lh, name, comp);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
        ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(offset, 42);
        centrals.push(ch, name);
        offset += 30 + name.length + comp.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}
