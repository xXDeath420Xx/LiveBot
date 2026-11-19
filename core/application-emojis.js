/**
 * Application Emoji registry — Discord's new application-scope emoji pool.
 *
 * Each Discord application can register up to 2000 of its own emoji that work
 * in every guild without needing CREATE_GUILD_EXPRESSIONS and without eating
 * the guild's 50-slot cap. CertiFried uses this for its branded palette:
 * status pills (online/offline/live), platform marks (twitch, kick, youtube,
 * tiktok, throne), loading spinner, approve/deny checks.
 *
 * API surface:
 *   - loadAll(client)         - fetch all registered app emoji on boot and cache them
 *   - get(nameOrId)           - return the Emoji object or null
 *   - mention(name)           - return "<:name:id>" for use inline in message content,
 *                               or the raw name as a Unicode fallback if not registered
 *   - upload({ name, image }) - register a new application emoji
 *   - remove(nameOrId)        - delete a registered application emoji
 *
 * Fallback behaviour: when a branded emoji isn't registered yet (fresh deploy,
 * or Discord outage), `mention(name)` returns the raw name string (`'check'`)
 * so callers never crash and the surrounding text still reads sensibly.
 */
import logger from '../utils/logger.js';

const LOG = '[AppEmojis]';
const byName = new Map();   // name -> ApplicationEmoji
const byId = new Map();     // id -> ApplicationEmoji
let loadedAt = 0;

/** Load every application-scope emoji into the in-process cache. */
export async function loadAll(client) {
    if (!client?.application) return;
    try {
        const emojis = await client.application.emojis.fetch();
        byName.clear(); byId.clear();
        for (const e of emojis.values()) {
            byName.set(e.name, e);
            byId.set(e.id, e);
        }
        loadedAt = Date.now();
        logger.info(`${LOG} loaded ${byName.size} application emoji`);
    } catch (err) {
        logger.warn(`${LOG} loadAll failed: ${err.message}`);
    }
}

/** Resolve by name OR id. Returns null when nothing matches. */
export function get(nameOrId) {
    if (!nameOrId) return null;
    const s = String(nameOrId);
    return byName.get(s) || byId.get(s) || null;
}

/**
 * `<a?:name:id>` ready for inlining into message content. Falls back to the
 * raw name wrapped in colons (`:check:`) when the emoji isn't registered —
 * Discord renders this as plain text, which is good enough as a placeholder
 * until the registration catches up.
 */
export function mention(name, fallback = null) {
    const e = get(name);
    if (!e) return fallback ?? `:${name}:`;
    return e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
}

/** Return `{ id, name, animated }` for use in button/select-menu emoji fields. */
export function partial(name) {
    const e = get(name);
    if (!e) return null;
    return { id: e.id, name: e.name, animated: !!e.animated };
}

/**
 * Register a new application emoji. `image` can be a Buffer, Base64 data URL,
 * or any value discord.js's resolveImage() accepts. Returns the created emoji.
 */
export async function upload(client, { name, image }) {
    if (!client?.application) throw new Error('client.application is not available');
    const created = await client.application.emojis.create({ attachment: image, name });
    byName.set(created.name, created);
    byId.set(created.id, created);
    return created;
}

/** Rename an existing application emoji. */
export async function rename(client, nameOrId, newName) {
    const e = get(nameOrId);
    if (!e) throw new Error(`No application emoji named "${nameOrId}"`);
    const edited = await client.application.emojis.edit(e.id, { name: newName });
    byName.delete(e.name);
    byName.set(edited.name, edited);
    byId.set(edited.id, edited);
    return edited;
}

/** Remove by name or id. */
export async function remove(client, nameOrId) {
    const e = get(nameOrId);
    if (!e) return false;
    await client.application.emojis.delete(e.id);
    byName.delete(e.name);
    byId.delete(e.id);
    return true;
}

/** Diagnostics for the dashboard overview page. */
export function stats() {
    return { count: byName.size, loadedAt, names: [...byName.keys()] };
}
