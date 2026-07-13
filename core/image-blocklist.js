/**
 * Known scam-image blocklist.
 *
 * When ANY user in a guild with phishing/scam protection enabled posts one of
 * the reference images (docs/scam.jpg, docs/image.jpg, docs/image2.jpg), the
 * message is deleted IMMEDIATELY. If the same user posts a blocked image across
 * more than 2 distinct channels, they are banned (1 day of messages swept) — no
 * warnings. Matching is perceptual (dHash + Hamming distance) so re-encoded /
 * resized / recompressed reposts are still caught, not just byte-identical files.
 *
 * Gate: phishing_config.enabled (a guild's scam protection). Fails open on any
 * error so the message pipeline never throws.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF_FILES = ['scam.jpg', 'image.jpg', 'image2.jpg'].map(f => path.join(__dirname, '..', 'docs', f));

const MAX_IMAGES = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const MATCH_DISTANCE = 10;   // Hamming distance over 64-bit dHash (≤10 ≈ same image)
const BAN_CHANNEL_THRESHOLD = 2; // ban once posted in MORE THAN 2 distinct channels (i.e. the 3rd)

// 9x8 grayscale row-wise "greater-than-neighbor" perceptual hash → 64-bit BigInt.
async function dHash(buffer) {
    const { data, info } = await sharp(buffer).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels || 1;
    const px = (r, c) => data[(r * 9 + c) * ch];
    let hash = 0n, bit = 0n;
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if (px(r, c) > px(r, c + 1)) hash |= (1n << bit);
            bit++;
        }
    }
    return hash;
}

function hamming(a, b) {
    let x = a ^ b, count = 0;
    while (x) { count += Number(x & 1n); x >>= 1n; }
    return count;
}

// Reference hashes computed once from the local files.
let refHashes = null;
async function getRefHashes() {
    if (refHashes) return refHashes;
    const out = [];
    for (const file of REF_FILES) {
        try {
            if (!fs.existsSync(file)) { logger.warn(`[ImageBlocklist] reference missing: ${file}`); continue; }
            out.push(await dHash(fs.readFileSync(file)));
        } catch (e) {
            logger.warn(`[ImageBlocklist] failed to hash ${file}: ${e.message}`);
        }
    }
    refHashes = out;
    logger.info(`[ImageBlocklist] loaded ${out.length} reference image hash(es)`);
    return out;
}

async function isProtectionOn(guildId) {
    try {
        const cfg = await configCache.get('phishing_config', guildId, async () => {
            const [rows] = await pool.execute('SELECT enabled FROM phishing_config WHERE guild_id = ? AND enabled = 1', [guildId]);
            return rows[0] || null;
        });
        return !!cfg;
    } catch {
        return false;
    }
}

async function downloadImage(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= MAX_BYTES ? buf : null;
}

async function ensureTable() {
    await pool.execute(`CREATE TABLE IF NOT EXISTS blocked_image_hits (
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        channel_id VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id, channel_id)
    )`);
}

/**
 * @returns {Promise<boolean>} true if a blocked image was found (message deleted).
 */
export async function checkBlockedImage(message) {
    try {
        if (!message.guild || !message.author || message.author.bot) return false;
        const images = [...message.attachments.values()].filter(a => a.contentType?.startsWith('image/'));
        if (!images.length) return false;

        if (!(await isProtectionOn(message.guild.id))) return false;

        const refs = await getRefHashes();
        if (!refs.length) return false;

        let matched = false;
        for (const att of images.slice(0, MAX_IMAGES)) {
            if (att.size && att.size > MAX_BYTES) continue;
            const buf = await downloadImage(att.url).catch(() => null);
            if (!buf) continue;
            let h;
            try { h = await dHash(buf); } catch { continue; }
            if (refs.some(ref => hamming(h, ref) <= MATCH_DISTANCE)) { matched = true; break; }
        }
        if (!matched) return false;

        const { guild, author, channel } = message;
        // 1) Delete the offending message immediately.
        await message.delete().catch(err => logger.warn(`[ImageBlocklist] delete failed: ${err.message}`));

        // 2) Record the (guild,user,channel) hit and count distinct channels spread.
        await ensureTable();
        await pool.execute(
            'INSERT IGNORE INTO blocked_image_hits (guild_id, user_id, channel_id) VALUES (?,?,?)',
            [guild.id, author.id, channel.id]
        );
        const [[{ n: channelCount }]] = [await pool.execute(
            'SELECT COUNT(*) AS n FROM blocked_image_hits WHERE guild_id = ? AND user_id = ?',
            [guild.id, author.id]
        )];

        logger.warn('[ImageBlocklist] blocked scam image', {
            guildId: guild.id, userId: author.id, channelId: channel.id, distinctChannels: channelCount,
        });

        // 3) Spread across MORE THAN 2 channels → ban (sweep 1 day of their messages).
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

export default checkBlockedImage;
