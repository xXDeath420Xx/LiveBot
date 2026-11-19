import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { buildAnnouncement, readAnnouncement } from './announcement-card.js';

/**
 * Posting side of the announcement cards, shared by `/manage announce` and the dashboard's Announce
 * page. The card layout lives in announcement-card.js; this file does the Discord I/O and
 * remembers where each post is (`announcement_posts`, migration 250).
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function uploadName(name) {
    const ext = (IMAGE_EXT.exec(name || '')?.[1] || 'png').toLowerCase();
    return `announcement.${ext}`;
}

/** `{ buffer, name }` as is; `{ url, name }` downloaded. Discord URLs are signed and expire, so always re-upload. */
async function loadImage(image) {
    if (!image) return null;
    if (image.buffer) return image;
    const res = await fetch(image.url);
    if (!res.ok) throw new Error(`Couldn't download the picture (HTTP ${res.status}).`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('That picture is over 10 MB.');
    return { buffer, name: image.name };
}

/**
 * Post a new card, or rewrite an existing one when `messageId` is given.
 * @param {object} p
 * @param {import('discord.js').GuildTextBasedChannel} p.channel
 * @param {string} [p.messageId]
 * @param {{title?:string, body:string, footer?:string, color?:number, pingRoleId?:string}} p.fields
 * @param {{buffer:Buffer,name:string}|{url:string,name:string}|null} p.image
 * @param {string} [p.userId]
 * @param {'command'|'dashboard'|'script'} [p.source]
 * @returns {Promise<import('discord.js').Message>}
 */
export async function publishAnnouncement({ channel, messageId, fields, image, userId, source = 'command' }) {
    const img = await loadImage(image);
    const imageName = img ? uploadName(img.name) : null;
    const payload = buildAnnouncement({ ...fields, imageName });
    const files = img ? [{ attachment: img.buffer, name: imageName }] : [];

    let msg;
    if (messageId) {
        msg = await channel.messages.fetch(messageId);
        // `attachments: []` drops the old file; the picture (if kept) was re-uploaded in `files`.
        await msg.edit({ components: payload.components, allowedMentions: payload.allowedMentions, files, attachments: [] });
    } else {
        msg = await channel.send({ ...payload, files });
    }

    try {
        await pool.execute(
            `INSERT INTO announcement_posts (guild_id, channel_id, message_id, title, created_by, source)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE title = VALUES(title), updated_at = NOW(), deleted_at = NULL`,
            [channel.guildId, channel.id, msg.id, fields.title?.slice(0, 256) || null, userId || null, source]);
    } catch (err) {
        // The post is out; a missing row only hides it from the dashboard list.
        logger.warn('[Announce] Could not record post', { messageId: msg.id, error: err.message });
    }
    return msg;
}

export async function deleteAnnouncement(channel, messageId) {
    try {
        const msg = await channel.messages.fetch(messageId);
        await msg.delete();
    } catch (err) {
        if (err.code !== 10008) throw err; // already gone is fine
    }
    await markDeleted(messageId);
}

export async function markDeleted(messageId) {
    await pool.execute('UPDATE announcement_posts SET deleted_at = NOW() WHERE message_id = ?', [messageId]);
}

export async function listAnnouncements(guildId, limit = 25) {
    const [rows] = await pool.execute(
        `SELECT channel_id, message_id, title, created_by, source, created_at, updated_at
           FROM announcement_posts WHERE guild_id = ? AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT ${Number(limit) | 0}`, [guildId]);
    return rows;
}

/** Fetch a post and read its fields back, or null if it isn't one of ours. */
export async function loadAnnouncement(channel, messageId) {
    const msg = await channel.messages.fetch(messageId);
    if (msg.author.id !== channel.client.user.id) return null;
    const fields = readAnnouncement(msg);
    return fields ? { ...fields, url: msg.url } : null;
}
