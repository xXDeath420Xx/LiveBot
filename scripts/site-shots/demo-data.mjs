/*
 * Maple Hollow: the invented Discord server every guide screenshot is taken from.
 *
 * Nothing here is real. The server, its members, channels, roles, streamers and feeds are made up for
 * the documentation, and the ids are obviously fake (they count up from 1000...). Never add a real
 * Discord user, server, Twitch/Kick/YouTube channel or any real member data to this file: the
 * screenshots are published on the public website.
 */

const id = (prefix, n) => `${prefix}${String(n).padStart(18 - String(prefix).length, '0')}`;

export const GUILD_ID = id('1000', 1);
export const BOT_ID = id('1009', 1);

export const guild = {
    id: GUILD_ID, name: 'Maple Hollow', icon: null, memberCount: 1284, ownerId: id('1001', 1),
};

/** Members. `colour` is the avatar colour of the drawn initials avatar (scripts/site-shots/assets.mjs). */
export const members = [
    { key: 'juniper', id: id('1001', 1), username: 'juniper.vale', displayName: 'Juniper Vale', colour: '#3f8f6b' },
    { key: 'rowan', id: id('1001', 2), username: 'rowanpike', displayName: 'Rowan Pike', colour: '#b5653a' },
    { key: 'sorrel', id: id('1001', 3), username: 'sorrelq', displayName: 'Sorrel Quinn', colour: '#6c5fc7' },
    { key: 'bramble', id: id('1001', 4), username: 'bramblebyte', displayName: 'Bramble', colour: '#a2475e' },
    { key: 'hazel', id: id('1001', 5), username: 'hazelmarsh', displayName: 'Hazel Marsh', colour: '#2f7fa8' },
    { key: 'pip', id: id('1001', 6), username: 'pipcalloway', displayName: 'Pip Calloway', colour: '#8a7a2b' },
    { key: 'thistle', id: id('1001', 7), username: 'thistledown', displayName: 'Thistle', colour: '#5d6b7a' },
    { key: 'fennel', id: id('1001', 8), username: 'fennelfox_', displayName: 'Fennel', colour: '#c0763a' },
    { key: 'wren', id: id('1001', 9), username: 'wren.alder', displayName: 'Wren Alder', colour: '#4f8a3a' },
    { key: 'spam', id: id('1001', 10), username: 'fr33-n1tro-drops', displayName: 'fr33-n1tro-drops', colour: '#7a7f87' },
];
export const member = Object.fromEntries(members.map((m) => [m.key, m]));

/** The signed-in dashboard user (the server owner). */
export const user = {
    id: member.juniper.id, username: member.juniper.username, globalName: member.juniper.displayName,
    avatar: null, isSuperAdmin: false, canCreateBots: false, guilds: [],
};

const roleNames = [
    ['Grove Keepers', 0x3f8f6b], ['Moderators', 0x2f7fa8], ['Regulars', 0x8a7a2b], ['Members', 0x99aab5],
    ['Muted', 0x5d6b7a], ['Verified', 0x4f8a3a], ['Live now', 0x9146ff], ['Stream pings', 0xb5653a],
    ['Seedling (level 5)', 0x6aa84f], ['Sapling (level 15)', 0x38761d], ['Old Oak (level 30)', 0x274e13],
    ['Night owls', 0x6c5fc7], ['Artists', 0xa2475e], ['Gamers', 0xc0763a], ['Birthday', 0xe0a526], ['Supporters', 0xe91e63],
];
export const roles = roleNames.map(([name, color], i) => ({
    id: id('1003', i + 1), name, color, hexColor: `#${color.toString(16).padStart(6, '0')}`, position: roleNames.length - i, managed: false, memberCount: 3 + ((i * 7) % 40),
}));
export const role = Object.fromEntries(roles.map((r) => [r.name.split(' ')[0].toLowerCase(), r]));

const channelNames = [
    'welcome', 'rules', 'announcements', 'general', 'stream-alerts', 'new-videos', 'level-ups', 'roles',
    'mod-log', 'server-log', 'starboard', 'suggestions', 'birthdays', 'support', 'bot-commands', 'music-requests',
];
export const channels = channelNames.map((name, i) => ({ id: id('1004', i + 1), name, type: 0, parentId: null }));
export const channel = Object.fromEntries(channels.map((c) => [c.name, c]));
export const voiceChannels = [
    { id: id('1005', 1), name: 'Campfire', type: 2 }, { id: id('1005', 2), name: 'Music Room', type: 2 }, { id: id('1005', 3), name: 'Quiet Study', type: 2 },
];
export const categories = [
    { id: id('1006', 1), name: 'Start here', type: 4 }, { id: id('1006', 2), name: 'Community', type: 4 }, { id: id('1006', 3), name: 'Support tickets', type: 4 },
];

/** Invented streamers. Channel names were made up for these docs. */
export const streamers = {
    rowan: { name: 'rowanpike_plays', title: 'Cozy farming sim, day 41: the greenhouse finally works', game: 'Stardew Valley', viewers: 87, platform: 'twitch' },
    sorrel: { name: 'sorrelquinnart', title: 'Painting the Maple Hollow banner, chill music', game: 'Art', viewers: 34, platform: 'youtube' },
    bramble: { name: 'bramblebyte_live', title: 'Speedrun practice, any% attempts', game: 'Celeste', viewers: 52, platform: 'kick' },
};

/** Other servers the owner can manage, for the server picker. */
export const otherGuilds = ['Lantern Moth Collective', 'Quiet Study Hall', 'Kettle & Quill'];

export const D = (y, m, d, h = 12, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min));
