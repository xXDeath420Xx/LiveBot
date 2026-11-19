/*
 * Stream bot music: the song request commands as ordinary stream bot automations (chat trigger → "Song requests:
 * run a command"), so a streamer can turn each on or off, rename it (the trigger text), add cooldowns or roles,
 * or chain more actions, on the Automations page.
 *
 *   commandDrafts({ aliases, enabled }) → automation drafts, one per command in text.js COMMANDS, plus
 *                                         "Song requests: announce requested songs" (trigger music.song_changed)
 *     aliases  true: every name the owner's Streamer.bot command answered to (a regex trigger such as
 *              ^!(?:skip|next|skipSong|nextSong)(?:\s|$)); false: the first name only, as a plain command trigger
 *   seedCommands(store, profileId, opts) → { created, existing }   never makes one twice (matched by name)
 *
 * Mod-only commands carry a "Viewer role: broadcaster or moderator" condition (Streamer.bot's Moderators group).
 */
import { COMMANDS } from './text.js';

export const NAME_PREFIX = 'Song requests: ';
const MAX_AUTOMATIONS = 200;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function commandDrafts({ aliases = false, enabled = false } = {}) {
    const out = COMMANDS.map((c) => {
        const names = aliases ? c.names : [c.names[0]];
        const match = names.length > 1
            ? { mode: 'regex', text: `^!(?:${names.map(esc).join('|')})(?:\\s|$)`, caseSensitive: false }
            : { mode: 'command', text: `!${names[0]}`, caseSensitive: false };
        return {
            name: `${NAME_PREFIX}!${c.names[0]}`,
            enabled,
            trigger_type: 'chat',
            trigger_config: { platforms: ['twitch', 'kick'], match },
            conditions: c.mod ? [{ type: 'role', roles: ['broadcaster', 'moderator'], mode: 'any' }] : [],
            actions: [{ type: 'music.command', command: c.key, input: '', reply: 'yes' }],
        };
    });
    // The owner's extension posted "Now playing … (requested by …)" for requested songs only.
    out.push({
        name: `${NAME_PREFIX}announce requested songs`,
        enabled,
        trigger_type: 'music.song_changed',
        trigger_config: {},
        conditions: [{ type: 'metadata', path: 'requested', op: 'eq', value: 'true' }],
        actions: [{ type: 'chat.send', platform: 'all', text: "Now playing: '{music.track}' by {music.artist} (requested by {music.requester})" }],
    });
    return out;
}

export async function seedCommands(store, profileId, opts = {}) {
    const existing = new Set((await store.listAutomations(profileId)).map((a) => a.name));
    let count = existing.size;
    const created = [];
    for (const d of commandDrafts(opts)) {
        if (existing.has(d.name)) continue;
        if (count >= MAX_AUTOMATIONS) break;
        created.push(await store.createAutomation(profileId, d));
        count++;
    }
    return { created: created.length, ids: created, existing: commandDrafts(opts).length - created.length };
}

export default { commandDrafts, seedCommands, NAME_PREFIX };
