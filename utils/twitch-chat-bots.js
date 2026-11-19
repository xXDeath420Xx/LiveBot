// Common Twitch chat bots, excluded from audience stats (top chatters, top words, emotes).
// Any login ending in "bot" is also treated as a bot.
const BOT_LOGINS = [
    'streamelements', 'streamlabs', 'nightbot', 'moobot', 'fossabot', 'wizebot', 'sery_bot',
    'soundalerts', 'frostytools', 'botrixoficial', 'kofistreambot', 'streamstickers', 'commanderroot',
    'pokemoncommunitygame', 'own3d', 'lumiastream', 'blerp', 'tangiabot', 'songlistbot', 'creatisbot',
    'deepbot', 'phantombot', 'coebot', 'vivbot', 'ankhbot', 'streamholics', 'electricallongboard',
    'drapsnatt', 'anotherttvviewer', 'aliceydra', 'lurxx', 'streamjar', 'pretzelrocks', 'restreambot',
    'kumabotdefender',
];

if (!BOT_LOGINS.every(b => /^[a-z0-9_]+$/.test(b))) throw new Error('invalid bot login in BOT_LOGINS');

export const TWITCH_CHAT_BOTS = new Set(BOT_LOGINS);

// Our own Twitch chat account (certifriedutility). Read on use, not at import, so it is set
// even when this module loads before .env does. Only a valid login is ever used.
function ownBotLogin() {
    const l = String(process.env.TWITCH_BOT_USERNAME || '').trim().toLowerCase();
    return /^[a-z0-9_]{1,25}$/.test(l) ? l : null;
}

export function isChatBot(login) {
    const l = String(login || '').toLowerCase();
    return TWITCH_CHAT_BOTS.has(l) || l.endsWith('bot') || (l !== '' && l === ownBotLogin());
}

/** SQL condition excluding bots on a login column. Inlines only the constant list above plus our own validated login. */
export function sqlNotBot(column) {
    const own = ownBotLogin();
    const list = own && !TWITCH_CHAT_BOTS.has(own) ? [...BOT_LOGINS, own] : BOT_LOGINS;
    return `LOWER(${column}) NOT LIKE '%bot' AND LOWER(${column}) NOT IN (${list.map(b => `'${b}'`).join(', ')})`;
}
