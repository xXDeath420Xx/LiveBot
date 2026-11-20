/*
 * Stream bot viewers: the points commands as ordinary stream bot automations (chat trigger → "Viewers: run a command"),
 * so a streamer can turn each on, rename it (the trigger text), change its cooldown or roles, or add actions.
 *
 *   commandDrafts({ currency, enabled }) → drafts: !points (and !<currency>, such as !coins), !top, !give, !gamble,
 *                                          !addpoints and !removepoints (moderators and the broadcaster only)
 *   seedCommands(store, profileId, opts) → { created, ids, existing }   never makes one twice (matched by name)
 *
 * Created switched off. Gambling also stays off in the settings until the streamer turns it on there.
 */
export const NAME_PREFIX = 'Viewers: ';
const MAX_AUTOMATIONS = 200;
const MOD = Object.freeze({ type: 'role', roles: ['broadcaster', 'moderator'], mode: 'any' });

export function commandDrafts({ currency = null, enabled = false } = {}) {
    const cmd = (text) => ({ platforms: ['twitch', 'kick'], match: { mode: 'command', text, caseSensitive: false } });
    const word = currency && /^[a-z0-9_]{1,20}$/.test(currency) && currency !== 'points' ? currency : null;
    const step = (command) => [{ type: 'viewers.command', command, reply: 'yes' }];
    return [
        { name: `${NAME_PREFIX}!points`, enabled, trigger_type: 'chat',
            trigger_config: word ? { platforms: ['twitch', 'kick'], match: { mode: 'regex', text: `^!(?:points|${word})(?:\\s|$)`, caseSensitive: false } } : cmd('!points'),
            conditions: [{ type: 'cooldown', scope: 'user', seconds: 10 }], actions: step('points') },
        { name: `${NAME_PREFIX}!top`, enabled, trigger_type: 'chat', trigger_config: cmd('!top'),
            conditions: [{ type: 'cooldown', scope: 'global', seconds: 30 }], actions: step('top') },
        { name: `${NAME_PREFIX}!give`, enabled, trigger_type: 'chat', trigger_config: cmd('!give'),
            conditions: [{ type: 'cooldown', scope: 'user', seconds: 10 }], actions: step('give') },
        { name: `${NAME_PREFIX}!gamble`, enabled, trigger_type: 'chat', trigger_config: cmd('!gamble'),
            conditions: [{ type: 'cooldown', scope: 'user', seconds: 60 }], actions: step('gamble') },
        { name: `${NAME_PREFIX}!addpoints`, enabled, trigger_type: 'chat', trigger_config: cmd('!addpoints'), conditions: [MOD], actions: step('addpoints') },
        { name: `${NAME_PREFIX}!removepoints`, enabled, trigger_type: 'chat', trigger_config: cmd('!removepoints'), conditions: [MOD], actions: step('removepoints') },
    ];
}

export async function seedCommands(store, profileId, opts = {}) {
    const existing = new Set((await store.listAutomations(profileId)).map((a) => a.name));
    let count = existing.size;
    const ids = [];
    const drafts = commandDrafts(opts);
    for (const d of drafts) {
        if (existing.has(d.name)) continue;
        if (count >= MAX_AUTOMATIONS) break;
        ids.push(await store.createAutomation(profileId, d));
        count++;
    }
    return { created: ids.length, ids, existing: drafts.length - ids.length };
}

export default { commandDrafts, seedCommands, NAME_PREFIX };
