/**
 * Announce API — `/api/guilds/:guildId/announce/*`
 *
 * Dashboard twin of `/manage announce`: post, edit and delete picture-on-top announcement cards.
 * Already gated by `apiCheckGuildAdmin` + `botContext` at the parent router, so
 * `req.botClient` is the guild's own bot. Card layout: core/announcement-card.js; posting and
 * the `announcement_posts` list: core/announcement-manager.js.
 */
import express from 'express';
import multer from 'multer';
import { PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';
import { parseHexColor, textLength, TEXT_LIMIT } from '../../../../core/announcement-card.js';
import {
    publishAnnouncement, deleteAnnouncement, listAnnouncements, loadAnnouncement, markDeleted, MAX_IMAGE_BYTES,
} from '../../../../core/announcement-manager.js';

const router = express.Router({ mergeParams: true });

const SNOWFLAKE = /^\d{15,25}$/;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });

function handleUploadError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That picture is over 10 MB.' : err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
}

/** The channel, only if it belongs to THIS guild and the bot can post pictures in it. */
async function postableChannel(req, channelId) {
    if (!SNOWFLAKE.test(channelId || '')) return { error: 'Pick a channel.' };
    const guild = req.botClient?.guilds?.cache?.get(req.params.guildId);
    if (!guild) return { error: "The bot isn't in this server (or is still starting up).", status: 503 };
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return { error: "That channel doesn't exist in this server." };
    const perms = channel.permissionsFor(guild.members.me);
    const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles];
    if (!perms?.has(need)) {
        return { error: `The bot needs View Channel, Send Messages and Attach Files in #${channel.name}.` };
    }
    return { channel };
}

function readFields(req, guildId) {
    const title = String(req.body.title || '').trim().slice(0, 256);
    const body = String(req.body.body || '').replace(/\r\n/g, '\n').trim();
    const footer = String(req.body.footer || '').trim().slice(0, 500);
    if (!body) return { error: 'The announcement text is empty.' };

    const colorRaw = String(req.body.color || '').trim();
    const color = parseHexColor(colorRaw);
    if (colorRaw && color == null) return { error: `"${colorRaw}" isn't a hex colour like #FF7518.` };

    let pingRoleId = String(req.body.pingRoleId || '').trim() || null;
    if (pingRoleId === guildId) pingRoleId = 'everyone';
    if (pingRoleId && pingRoleId !== 'everyone' && !SNOWFLAKE.test(pingRoleId)) return { error: 'Unknown ping role.' };

    const fields = { title, body, footer, color, pingRoleId };
    const len = textLength(fields);
    if (len > TEXT_LIMIT) return { error: `Text is ${len} characters; Discord allows ${TEXT_LIMIT}. Trim ${len - TEXT_LIMIT}.` };
    return { fields };
}

function readImage(req) {
    if (!req.file) return { image: null };
    if (!req.file.mimetype?.startsWith('image/')) return { error: 'The picture has to be an image (PNG, JPG, GIF or WebP).' };
    return { image: { buffer: req.file.buffer, name: req.file.originalname } };
}

function discordError(e) {
    if (e.code === 50013 || e.code === 50001) return "The bot doesn't have permission to post there.";
    if (e.code === 10008) return 'That message no longer exists.';
    return e.message;
}

// GET / — recent posts (newest first) with channel names
router.get('/', async (req, res) => {
    try {
        const guild = req.botClient?.guilds?.cache?.get(req.params.guildId);
        const rows = await listAnnouncements(req.params.guildId);
        res.json({
            success: true,
            textLimit: TEXT_LIMIT,
            posts: rows.map(r => ({
                ...r,
                channel_name: guild?.channels?.cache?.get(r.channel_id)?.name ?? null,
                url: `https://discord.com/channels/${req.params.guildId}/${r.channel_id}/${r.message_id}`,
            })),
        });
    } catch (e) {
        logger.error('[API Announce GET] ' + e.message);
        res.status(500).json({ error: 'Failed to load announcements' });
    }
});

// GET /:channelId/:messageId — one post's current fields, for the editor
router.get('/:channelId/:messageId', async (req, res) => {
    try {
        const { channel, error, status } = await postableChannel(req, req.params.channelId);
        if (error) return res.status(status || 400).json({ error });
        if (!SNOWFLAKE.test(req.params.messageId)) return res.status(400).json({ error: 'Bad message id.' });
        const post = await loadAnnouncement(channel, req.params.messageId);
        if (!post) return res.status(404).json({ error: "That message isn't an announcement card from this bot." });
        res.json({ success: true, post: { ...post, channelId: channel.id, messageId: req.params.messageId } });
    } catch (e) {
        if (e.code === 10008) {
            await markDeleted(req.params.messageId).catch(() => {});
            return res.status(404).json({ error: 'That message was deleted in Discord.', gone: true });
        }
        logger.error('[API Announce GET one] ' + e.message);
        res.status(500).json({ error: discordError(e) });
    }
});

// POST / — multipart: channelId, title, body, footer, color, pingRoleId, [image]
router.post('/', upload.single('image'), handleUploadError, async (req, res) => {
    try {
        const f = readFields(req, req.params.guildId);
        if (f.error) return res.status(400).json({ error: f.error });
        const img = readImage(req);
        if (img.error) return res.status(400).json({ error: img.error });
        const { channel, error, status } = await postableChannel(req, req.body.channelId);
        if (error) return res.status(status || 400).json({ error });

        const msg = await publishAnnouncement({
            channel, fields: f.fields, image: img.image, userId: req.user?.id, source: 'dashboard',
        });
        logger.info(`[API Announce] posted ${msg.id} in #${channel.name}`, { guildId: req.params.guildId, userId: req.user?.id });
        res.json({ success: true, messageId: msg.id, url: msg.url });
    } catch (e) {
        logger.error('[API Announce POST] ' + e.message);
        res.status(500).json({ error: discordError(e) });
    }
});

// PUT /:channelId/:messageId — same fields as POST, plus removeImage=1. No new image = keep the old one.
router.put('/:channelId/:messageId', upload.single('image'), handleUploadError, async (req, res) => {
    try {
        const f = readFields(req, req.params.guildId);
        if (f.error) return res.status(400).json({ error: f.error });
        const img = readImage(req);
        if (img.error) return res.status(400).json({ error: img.error });
        const { channel, error, status } = await postableChannel(req, req.params.channelId);
        if (error) return res.status(status || 400).json({ error });

        const current = await loadAnnouncement(channel, req.params.messageId);
        if (!current) return res.status(404).json({ error: "That message isn't an announcement card from this bot." });

        let image = img.image;
        if (!image && current.imageUrl && req.body.removeImage !== '1') {
            image = { url: current.imageUrl, name: new URL(current.imageUrl).pathname.split('/').pop() };
        }
        const msg = await publishAnnouncement({
            channel, messageId: req.params.messageId, fields: f.fields, image, userId: req.user?.id, source: 'dashboard',
        });
        res.json({ success: true, messageId: msg.id, url: msg.url });
    } catch (e) {
        logger.error('[API Announce PUT] ' + e.message);
        res.status(e.code === 10008 ? 404 : 500).json({ error: discordError(e) });
    }
});

// DELETE /:channelId/:messageId — remove the post from Discord and the list
router.delete('/:channelId/:messageId', async (req, res) => {
    try {
        const { channel, error, status } = await postableChannel(req, req.params.channelId);
        if (error) return res.status(status || 400).json({ error });
        const post = await loadAnnouncement(channel, req.params.messageId).catch(e => (e.code === 10008 ? 'gone' : Promise.reject(e)));
        if (!post) return res.status(404).json({ error: "That message isn't an announcement card from this bot." });
        await deleteAnnouncement(channel, req.params.messageId);
        res.json({ success: true });
    } catch (e) {
        logger.error('[API Announce DELETE] ' + e.message);
        res.status(500).json({ error: discordError(e) });
    }
});

export default router;
