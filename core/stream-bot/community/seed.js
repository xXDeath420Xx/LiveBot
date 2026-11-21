/*
 * Stream bot community features: the chat commands as ordinary automations (chat trigger → "… run a command"), so a
 * streamer can turn each on, rename it (the trigger text), change its cooldown or roles, or add steps. Created switched
 * off; the games, the store and media share are also off in their own settings until the streamer turns them on.
 *
 *   commandDrafts(group) → drafts      group: 'quotes' | 'games' | 'store' | 'media' | 'tts'
 *   seedCommands(store, profileId, group) → { created, ids, existing }   never makes one twice (matched by name)
 *
 * Names: "Quotes: !quote", "Games: !slots", "Store: !redeem", "Media share: !media", "Text to speech: !tts".
 * Chat words avoid the song request commands (!queue, !next): the line-up uses !join, !leave and !lineup.
 */
export const GROUPS = Object.freeze(['quotes', 'games', 'store', 'media', 'tts']);
const MAX_AUTOMATIONS = 200;
const MOD = Object.freeze({ type: 'role', roles: ['broadcaster', 'moderator'], mode: 'any' });
const MOD_VIP = Object.freeze({ type: 'role', roles: ['broadcaster', 'moderator', 'vip'], mode: 'any' });
const PLATFORMS = ['twitch', 'kick', 'youtube'];
// Points games, raffles, the store and media share are Twitch and Kick only (YouTube API policy III.F.3.c, youtube/policy.js).
const POINTS_ONLY = ['twitch', 'kick'];
const cmd = (text, platforms = PLATFORMS) => ({ platforms, match: { mode: 'command', text, caseSensitive: false } });
const cool = (scope, seconds) => ({ type: 'cooldown', scope, seconds });

function drafts(group) {
    const one = (prefix, type, word, command, conditions = [], extra = {}, platforms = PLATFORMS) => ({
        name: `${prefix}${word}`, enabled: false, trigger_type: 'chat', trigger_config: cmd(word, platforms), conditions, actions: [{ type, command, reply: 'yes', ...extra }],
    });
    const points = (prefix, type, word, command, conditions = [], extra = {}) => one(prefix, type, word, command, conditions, extra, POINTS_ONLY);
    switch (group) {
        case 'quotes': return [
            one('Quotes: ', 'quotes.command', '!quote', 'quote', [cool('user', 10)]),
            one('Quotes: ', 'quotes.command', '!addquote', 'addquote', [MOD_VIP]),
            one('Quotes: ', 'quotes.command', '!delquote', 'delquote', [MOD]),
        ];
        case 'games': return [
            points('Games: ', 'games.command', '!slots', 'slots', [cool('user', 30)]),
            points('Games: ', 'games.command', '!duel', 'duel', [cool('user', 30)]),
            points('Games: ', 'games.command', '!accept', 'accept'),
            points('Games: ', 'games.command', '!decline', 'decline'),
            points('Games: ', 'games.command', '!heist', 'heist', [cool('user', 10)]),
            one('Games: ', 'games.command', '!join', 'join', [cool('user', 10)]),
            one('Games: ', 'games.command', '!leave', 'leave'),
            one('Games: ', 'games.command', '!lineup', 'lineup', [cool('user', 10)]),
            points('Games: ', 'games.command', '!ticket', 'ticket', [cool('user', 5)]),
            points('Games: ', 'games.command', '!raffle', 'raffle', [cool('user', 10)]),
        ];
        case 'store': return [
            points('Store: ', 'store.command', '!store', 'list', [cool('global', 30)], { input: '' }),
            points('Store: ', 'store.command', '!redeem', 'redeem', [cool('user', 10)], { input: '' }),
        ];
        case 'media': return [
            points('Media share: ', 'media.command', '!media', 'request', [cool('user', 30)], { input: '' }),
            points('Media share: ', 'media.command', '!mediaqueue', 'queue', [cool('global', 15)], { input: '' }),
            points('Media share: ', 'media.command', '!mediaapprove', 'approve', [MOD], { input: '' }),
            points('Media share: ', 'media.command', '!mediadeny', 'deny', [MOD], { input: '' }),
            points('Media share: ', 'media.command', '!mediaskip', 'skip', [MOD], { input: '' }),
        ];
        case 'tts': return [{
            // Off, moderators and VIPs only to start with, a minute apart: the streamer decides whether all of chat may use it.
            name: 'Text to speech: !tts', enabled: false, trigger_type: 'chat', trigger_config: { platforms: PLATFORMS, match: { mode: 'starts', text: '!tts ', caseSensitive: false } },
            conditions: [MOD_VIP, cool('user', 60)], actions: [{ type: 'tts.say', text: '{user.name} says {message}', voice: '', dropCommand: 'yes' }],
        }];
        default: return [];
    }
}

export function commandDrafts(group) { return drafts(group); }

export async function seedCommands(store, profileId, group) {
    const list = drafts(group);
    if (!list.length) return { created: 0, ids: [], existing: 0 };
    const existing = new Set((await store.listAutomations(profileId)).map((a) => a.name));
    let count = existing.size;
    const ids = [];
    for (const d of list) {
        if (existing.has(d.name)) continue;
        if (count >= MAX_AUTOMATIONS) break;
        ids.push(await store.createAutomation(profileId, d));
        count++;
    }
    return { created: ids.length, ids, existing: list.length - ids.length };
}

export default { commandDrafts, seedCommands, GROUPS };
