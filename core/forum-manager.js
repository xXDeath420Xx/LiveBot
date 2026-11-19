/*
 * Forum channel automation.
 *
 * `forum_config` shipped as a schema with no reader — a row could be created and none of its
 * settings did anything. This applies them when a thread is created in a configured forum:
 *
 *   default_slowmode        seconds of slowmode on the new thread
 *   default_auto_archive    minutes of inactivity before Discord archives it
 *   require_tag             delete a thread posted with no tag, and tell the author why
 *   default_reaction_emoji  the bot adds this to the opening post
 *   auto_lock_on_archive    lock a thread when it archives (see threadUpdate)
 *
 * One row per forum channel — `forum_config` is keyed on `id` with an index on
 * forum_channel_id, so a guild can configure several forums independently.
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // forumChannelId -> { value, expires }

export function invalidate(forumChannelId) {
    if (forumChannelId) cache.delete(forumChannelId);
    else cache.clear();
}

/** Config for one forum channel, or null when that forum is not configured. */
export async function getForumConfig(forumChannelId) {
    const hit = cache.get(forumChannelId);
    if (hit && hit.expires > Date.now()) return hit.value;

    let value = null;
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM forum_config WHERE forum_channel_id = ? LIMIT 1',
            [forumChannelId]
        );
        value = rows[0] ?? null;
    } catch (err) {
        logger.warn(`[Forum] Could not read forum_config for ${forumChannelId}: ${err.message}`);
    }

    cache.set(forumChannelId, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
}

/** Guild-wide defaults from the dashboard, used when a forum row leaves a value unset. */
async function guildDefaults(guildId) {
    try {
        const { getConfig } = await import('./feature-config.js');
        return await getConfig('forums', guildId);
    } catch {
        return {};
    }
}

function truthy(v) {
    return v === 1 || v === true || v === '1';
}

/**
 * Apply forum rules to a newly created thread.
 * Returns true if the thread was deleted (so the caller stops processing it).
 */
export async function applyToNewThread(thread) {
    const parent = thread.parent;
    // ChannelType.GuildForum === 15. Only forum posts have tags or these semantics.
    if (!parent || parent.type !== 15) return false;

    const cfg = await getForumConfig(parent.id);
    const defaults = await guildDefaults(thread.guild.id);

    // The feature can be switched off guild-wide without deleting per-forum rows.
    if (defaults && 'enabled' in defaults && !truthy(defaults.enabled)) return false;
    if (!cfg) return false;

    // ── Tag requirement ────────────────────────────────────────────────────────────────
    // Enforced first: if the post is going to be removed, there is no point configuring it.
    if (truthy(cfg.require_tag) && (!thread.appliedTags || thread.appliedTags.length === 0)) {
        const available = (parent.availableTags || []).map(t => t.name).join(', ');
        try {
            const owner = thread.ownerId
                ? await thread.guild.members.fetch(thread.ownerId).catch(() => null)
                : null;
            await thread.delete('Forum rules: a tag is required on every post');
            if (owner) {
                owner.send(
                    `Your post in **${parent.name}** was removed because that forum requires a tag.\n` +
                    (available ? `Available tags: ${available}\n` : '') +
                    'Please post again and pick a tag.'
                ).catch(() => { /* DMs closed — nothing further we can do */ });
            }
            logger.info(`[Forum] Removed untagged post in ${parent.name}`, {
                guildId: thread.guild.id, forumId: parent.id, threadId: thread.id,
            });
        } catch (err) {
            logger.warn(`[Forum] Could not remove untagged post: ${err.message}`);
        }
        return true;
    }

    // ── Slowmode + auto-archive ────────────────────────────────────────────────────────
    const edit = {};
    const slowmode = Number(cfg.default_slowmode) || 0;
    if (slowmode > 0) edit.rateLimitPerUser = Math.min(slowmode, 21600);

    // Discord accepts only these four values; anything else is rejected outright.
    const archive = Number(cfg.default_auto_archive) || Number(defaults?.default_auto_archive_hours) * 60 || 0;
    if (archive > 0) {
        const ALLOWED = [60, 1440, 4320, 10080];
        edit.autoArchiveDuration = ALLOWED.includes(archive)
            ? archive
            : ALLOWED.reduce((best, v) => (Math.abs(v - archive) < Math.abs(best - archive) ? v : best));
    }

    if (Object.keys(edit).length) {
        await thread.edit(edit).catch(err => {
            logger.warn(`[Forum] Could not apply thread settings in ${parent.name}: ${err.message}`);
        });
    }

    // ── Default reaction on the opening post ───────────────────────────────────────────
    if (cfg.default_reaction_emoji) {
        try {
            // The starter message is not always cached the instant the thread event fires.
            const starter = await thread.fetchStarterMessage().catch(() => null);
            if (starter) await starter.react(cfg.default_reaction_emoji);
        } catch (err) {
            logger.warn(`[Forum] Could not add default reaction in ${parent.name}: ${err.message}`);
        }
    }

    return false;
}

/**
 * Lock a thread when Discord archives it, if the forum asks for that.
 * Called from threadUpdate, where we can see the archived flag flip.
 */
export async function applyOnArchive(oldThread, newThread) {
    const parent = newThread.parent;
    if (!parent || parent.type !== 15) return;
    if (oldThread.archived || !newThread.archived || newThread.locked) return;

    const cfg = await getForumConfig(parent.id);
    if (!cfg || !truthy(cfg.auto_lock_on_archive)) return;
    // The server-wide switch on the dashboard turns every forum rule off, this one included.
    const defaults = await guildDefaults(newThread.guild.id);
    if (defaults && 'enabled' in defaults && !truthy(defaults.enabled)) return;

    await newThread.setLocked(true, 'Forum rules: lock on archive').catch(err => {
        logger.warn(`[Forum] Could not lock archived thread: ${err.message}`);
    });
}

export default { getForumConfig, applyToNewThread, applyOnArchive, invalidate };
