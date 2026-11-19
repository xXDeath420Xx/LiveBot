/**
 * Known scam-image blocklist.
 *
 * When a user posts an image matching a blocklist entry, the message is deleted immediately. If the
 * same user lands matches in more than 2 distinct channels inside the hit window, they are banned
 * (1 day of messages swept). Gated on phishing_config.enabled; fails open on any error so the
 * message pipeline never throws.
 *
 * Matching rules, thresholds and the reasoning behind them live in core/image-fingerprint.js.
 * In short: two independent fingerprints (dHash + a colour signature) must BOTH agree, and any
 * image whose hash is degenerate is refused in both directions.
 *
 * blocked_images also holds avatar protection's protected images and known scam avatars
 * (core/avatar-protection.js, migration 326), told apart by `kind`. Everything here reads and writes
 * kind 'message' only (the column default), so a staff avatar is never treated as a scam post.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';
import {
    fingerprint, matchEntry, sigToHex, sigFromHex,
    DHASH_MATCH, COLOUR_MATCH, MIN_BITS, MAX_BITS,
} from './image-fingerprint.js';
import { isImageAttachment, imageAttachments, fetchImageBytes } from './message-images.js';
import { protectionHold, isIgnoredChannel } from './protection-exempt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Seeded into the DB once, on first load, so the original three references survive the move off
// disk. After that the table is the only source of truth and these files are never read again.
const SEED_FILES = [
    ['scam.jpg', 'MrBeast crypto-casino (bozawin)'],
    ['image.jpg', 'MrBeast crypto-casino (fomawin)'],
    ['image2.jpg', 'Fake withdrawal confirmation'],
].map(([f, label]) => [path.join(__dirname, '..', 'docs', f), label]);

const MAX_IMAGES = 4;
const MAX_BYTES = 8 * 1024 * 1024;

const BAN_CHANNEL_THRESHOLD = 2;    // Ban once matches land in MORE THAN 2 channels (i.e. the 3rd).
const HIT_WINDOW_MINUTES = 120;     // Only channels hit inside this window count toward the ban.
const CACHE_TTL_MS = 60 * 1000;

export { fingerprint, matchEntry, DHASH_MATCH, COLOUR_MATCH, MIN_BITS, MAX_BITS };

/* ────────────────────────── blocklist storage ────────────────────────── */

let cache = { at: 0, rows: [] };
let seeded = false;

async function seedOnce() {
    if (seeded) return;
    seeded = true;
    try {
        const [[{ n }]] = await pool.execute("SELECT COUNT(*) AS n FROM blocked_images WHERE kind = 'message'");
        if (n > 0) return;
        for (const [file, label] of SEED_FILES) {
            if (!fs.existsSync(file)) { logger.warn(`[ImageBlocklist] seed missing: ${file}`); continue; }
            const fp = await fingerprint(fs.readFileSync(file));
            if (!fp.usable) { logger.warn(`[ImageBlocklist] seed has a degenerate hash, skipped: ${file}`); continue; }
            await pool.execute(
                `INSERT IGNORE INTO blocked_images (guild_id, dhash, bits_set, colour_sig, label, added_by)
                 VALUES ('0', ?, ?, ?, ?, 'seed')`,
                [fp.dhash.toString(16).padStart(16, '0'), fp.bitsSet, sigToHex(fp.colourSig), label]
            );
        }
        logger.info('[ImageBlocklist] seeded blocklist from docs/ references');
    } catch (e) {
        logger.error('[ImageBlocklist] seed failed', { error: e.message });
    }
}

async function getEntries(guildId) {
    await seedOnce();
    if (Date.now() - cache.at < CACHE_TTL_MS) return cache.rows.filter(r => r.guild_id === '0' || r.guild_id === guildId);
    try {
        const [rows] = await pool.execute(
            "SELECT id, guild_id, dhash, bits_set, colour_sig, label FROM blocked_images WHERE kind = 'message'"
        );
        cache = {
            at: Date.now(),
            rows: rows.map(r => ({
                id: r.id,
                guild_id: r.guild_id,
                label: r.label,
                dhash: BigInt('0x' + r.dhash),
                bitsSet: r.bits_set,
                colourSig: sigFromHex(r.colour_sig),
            })),
        };
        return cache.rows.filter(r => r.guild_id === '0' || r.guild_id === guildId);
    } catch (e) {
        logger.error('[ImageBlocklist] failed to load blocklist', { error: e.message });
        return cache.rows.filter(r => r.guild_id === '0' || r.guild_id === guildId);
    }
}

/** Drop the cache so a just-added entry takes effect immediately rather than up to a minute later. */
export function invalidateBlocklistCache() { cache = { at: 0, rows: cache.rows }; }

/* ────────────────────────── operator API (/admin blocklist) ────────────────────────── */

export async function addBlockedImage({ guildId = '0', url, label, addedBy }) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ok: false, reason: `could not download the image (HTTP ${res.status})` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { ok: false, reason: 'image is larger than 8 MB' };

    let fp;
    try { fp = await fingerprint(buf); }
    catch (e) { return { ok: false, reason: `could not read that as an image (${e.message})` }; }

    // Refusing here is the whole point of bits_set. A flat or gradient image produces a hash that
    // matches unrelated images at distance 0, so blocking one would delete innocent posts forever.
    if (!fp.usable) {
        return {
            ok: false,
            reason: `that image is too flat to fingerprint safely (${fp.bitsSet}/64 bits of detail, needs ${MIN_BITS}-${MAX_BITS}). `
                + 'Blocking it would match unrelated images. Use a crop with more visible detail, or rely on the OCR scam filter for this one.',
        };
    }

    const hex = fp.dhash.toString(16).padStart(16, '0');
    try {
        const [r] = await pool.execute(
            `INSERT INTO blocked_images (guild_id, dhash, bits_set, colour_sig, label, added_by, source_url)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [guildId, hex, fp.bitsSet, sigToHex(fp.colourSig), label || null, addedBy || null, url.slice(0, 500)]
        );
        invalidateBlocklistCache();
        return { ok: true, id: r.insertId, bitsSet: fp.bitsSet };
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return { ok: false, reason: 'that image is already on the blocklist' };
        return { ok: false, reason: e.message };
    }
}

export async function listBlockedImages(guildId) {
    const [rows] = await pool.execute(
        `SELECT id, guild_id, label, bits_set, added_by, created_at FROM blocked_images
         WHERE guild_id IN ('0', ?) AND kind = 'message' ORDER BY id`,
        [guildId]
    );
    return rows;
}

export async function removeBlockedImage(id, guildId) {
    // A guild may only remove its own entries; global seeds are shared across all 82 servers.
    const [r] = await pool.execute("DELETE FROM blocked_images WHERE id = ? AND guild_id = ? AND kind = 'message'", [id, guildId]);
    invalidateBlocklistCache();
    return r.affectedRows > 0;
}

/* ────────────────────────── message pipeline ────────────────────────── */

async function isProtectionOn(guildId) {
    try {
        // The whole row: this key is shared with PhishingDetectionManager.getConfig, and this runs first on
        // every image post. Caching a partial row here left that scanner with no scan_images, so it skipped OCR.
        const cfg = await configCache.get('phishing_config', guildId, async () => {
            const [rows] = await pool.execute('SELECT * FROM phishing_config WHERE guild_id = ? AND enabled = 1', [guildId]);
            return rows[0] || null;
        });
        return !!cfg;
    } catch {
        return false;
    }
}

// Shared with the OCR / QR scan (core/message-images.js): one download per image per message.
async function downloadImage(url) {
    return fetchImageBytes(url, { maxBytes: MAX_BYTES, timeoutMs: 8000 }).catch(() => null);
}

/**
 * @returns {Promise<boolean>} true if a blocked image was found (message deleted).
 */
export async function checkBlockedImage(message) {
    try {
        if (!message.guild || !message.author || message.author.bot) return false;
        const images = imageAttachments(message);
        if (!images.length) return false;

        if (!(await isProtectionOn(message.guild.id))) return false;
        // Channels and categories the server told the message protections to ignore.
        if (await isIgnoredChannel(message.channel)) return false;

        const entries = await getEntries(message.guild.id);
        if (!entries.length) return false;

        let hit = null;
        for (const att of images.slice(0, MAX_IMAGES)) {
            // No size pre-check: `size` is the poster's number, and downloadImage already refuses
            // anything over the ceiling on the bytes it actually receives.
            const buf = await downloadImage(att.url).catch(() => null);
            if (!buf) continue;
            let fp;
            try { fp = await fingerprint(buf); } catch { continue; }
            hit = matchEntry(fp, entries);
            if (hit) break;
        }
        if (!hit) return false;

        const { guild, author, channel } = message;
        // Unified allowlist / global pause: the message stays (core/protection-exempt.js logs the skip).
        if (message.member && await protectionHold(message.member, 'delete', 'Scam-image blocklist')) return false;
        // 1) Delete the offending message immediately.
        await message.delete().catch(err => logger.warn(`[ImageBlocklist] delete failed: ${err.message}`));

        // 2) Record the hit. ON DUPLICATE KEY refreshes last_seen so the ban counts a live burst
        //    rather than every channel this user has ever tripped.
        await pool.execute(
            `INSERT INTO blocked_image_hits (guild_id, user_id, channel_id) VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE last_seen = NOW()`,
            [guild.id, author.id, channel.id]
        );

        // NOTE: pool.execute resolves to [rows, fields]. This previously read
        //   const [[{ n: channelCount }]] = [await pool.execute(...)]
        // which destructured `{n}` off the ROWS ARRAY rather than off rows[0], so channelCount was
        // always undefined and `undefined > 2` is false — the ban below had never once been
        // reachable in production. blocked_image_hits was empty across all 82 guilds.
        const [countRows] = await pool.execute(
            `SELECT COUNT(*) AS n FROM blocked_image_hits
             WHERE guild_id = ? AND user_id = ? AND last_seen > DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
            [guild.id, author.id, HIT_WINDOW_MINUTES]
        );
        const channelCount = Number(countRows[0]?.n ?? 0);

        logger.warn('[ImageBlocklist] blocked scam image', {
            guildId: guild.id, userId: author.id, channelId: channel.id,
            entryId: hit.id, label: hit.label,
            dhashDistance: hit.distance, colourDistance: Number(hit.colour.toFixed(1)),
            distinctChannels: channelCount,
        });

        // 3) Spread across MORE THAN 2 channels -> ban (sweep 1 day of their messages).
        //    Each individual match already required two independent fingerprints to agree; needing
        //    three of them, from one user, in three channels, inside the window, is what makes an
        //    automatic ban defensible.
        if (channelCount > BAN_CHANNEL_THRESHOLD) {
            try {
                await guild.members.ban(author.id, {
                    deleteMessageSeconds: 86400,
                    reason: 'Auto-ban: posted a known scam image across 3+ channels',
                });
                logger.warn('[ImageBlocklist] BANNED for scam-image spread', {
                    guildId: guild.id, userId: author.id, distinctChannels: channelCount,
                });
            } catch (e) {
                logger.error('[ImageBlocklist] ban failed (check bot Ban Members perm + role position)', { error: e.message, guildId: guild.id, userId: author.id });
            }
        }
        return true;
    } catch (e) {
        logger.error('[ImageBlocklist] handler error', { error: e.message });
        return false;
    }
}

/**
 * Add the images of a just-confirmed scam post to this guild's blocklist.
 *
 * Called by the OCR scam filter the moment its classifier fires. OCR is seconds per image behind a
 * process-wide mutex; the fingerprint match is one download and runs earlier in the pipeline. So the
 * expensive judgement is made once and the cheap one enforces it for every copy that follows —
 * which is what a burst across nine channels in twenty-one seconds actually needs.
 *
 * Guild-scoped by design. These entries are written by an automatic classifier rather than by a
 * human with /admin blocklist, so their blast radius stays inside the server that produced them.
 *
 * Degenerate hashes are refused exactly as they are for a manual add — a flat image matches
 * everything, and one learned automatically would quietly delete unrelated posts until someone
 * noticed.
 *
 * @returns {Promise<number>} how many new entries were stored.
 */
export async function learnScamImages({ guildId, attachments, label = 'auto: image scam' }) {
    let learned = 0;
    const images = [...(attachments || [])].filter(isImageAttachment).slice(0, MAX_IMAGES);

    for (const att of images) {
        try {
            const buf = await downloadImage(att.url);
            if (!buf) continue;
            const fp = await fingerprint(buf);
            if (!fp.usable) {
                logger.debug('[ImageBlocklist] not learning a degenerate hash', {
                    guildId, name: att.name, bitsSet: fp.bitsSet,
                });
                continue;
            }
            const [res] = await pool.execute(
                `INSERT IGNORE INTO blocked_images (guild_id, dhash, bits_set, colour_sig, label, added_by)
                 VALUES (?, ?, ?, ?, ?, 'auto')`,
                [String(guildId), fp.dhash.toString(16).padStart(16, '0'), fp.bitsSet,
                 sigToHex(fp.colourSig), String(label).substring(0, 200)]
            );
            if (res?.affectedRows) learned++;
        } catch (e) {
            logger.warn('[ImageBlocklist] failed to learn scam image', { guildId, error: e.message });
        }
    }

    if (learned) {
        invalidateBlocklistCache();
        logger.warn('[ImageBlocklist] learned scam image(s) from an OCR match', { guildId, learned, label });
    }
    return learned;
}

export default checkBlockedImage;
