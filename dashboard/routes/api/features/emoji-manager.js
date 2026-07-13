/**
 * Emoji & Sticker Manager API
 * Proxies CRUD operations to Discord API for server emojis and stickers
 */

import express from 'express';
import multer from 'multer';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });

// Multer for emoji uploads (256KB max)
const emojiUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 256 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PNG, JPEG, GIF, or WebP files are accepted for emojis'));
        }
    }
});

// Multer for sticker uploads (512KB max)
const stickerUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 512 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/apng', 'image/gif'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PNG or APNG files are accepted for stickers'));
        }
    }
});

// Emoji slot limits by boost tier
const EMOJI_SLOTS = { 0: 50, 1: 100, 2: 150, 3: 250 };
const STICKER_SLOTS = { 0: 5, 1: 15, 2: 30, 3: 60 };

/**
 * Handle multer errors with user-friendly messages
 */
function handleUploadError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File is too large' });
        }
        return res.status(400).json({ error: err.message });
    } else if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
}

/**
 * GET / — List all emojis and stickers with slot info
 */
router.get('/', async (req, res) => {
    try {
        const guild = req.guildObject;
        if (!guild) return res.status(404).json({ error: 'Guild not found' });

        // Fetch fresh data from Discord
        const [emojis, stickers] = await Promise.all([
            guild.emojis.fetch(),
            guild.stickers.fetch()
        ]);

        const staticEmojis = [];
        const animatedEmojis = [];

        for (const emoji of emojis.values()) {
            const data = {
                id: emoji.id,
                name: emoji.name,
                animated: emoji.animated,
                url: emoji.imageURL({ size: 128, extension: emoji.animated ? 'gif' : 'webp' }),
                managed: emoji.managed,
                roles: emoji.roles.cache.map(r => ({ id: r.id, name: r.name })),
                createdAt: emoji.createdAt?.toISOString()
            };
            if (emoji.animated) {
                animatedEmojis.push(data);
            } else {
                staticEmojis.push(data);
            }
        }

        const stickerList = stickers.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description || '',
            tags: s.tags || '',
            format: s.format,
            url: s.url,
            createdAt: s.createdAt?.toISOString()
        }));

        const tier = guild.premiumTier;
        const emojiSlots = EMOJI_SLOTS[tier] || 50;
        const stickerSlots = STICKER_SLOTS[tier] || 5;

        res.json({
            success: true,
            emojis: {
                static: staticEmojis.sort((a, b) => a.name.localeCompare(b.name)),
                animated: animatedEmojis.sort((a, b) => a.name.localeCompare(b.name))
            },
            stickers: stickerList.sort((a, b) => a.name.localeCompare(b.name)),
            limits: {
                emojiSlots,
                stickerSlots,
                staticUsed: staticEmojis.length,
                animatedUsed: animatedEmojis.length,
                stickersUsed: stickerList.length,
                premiumTier: tier
            }
        });
    } catch (error) {
        logger.error('[API EmojiManager] Error listing emojis/stickers:', { error: error.message, guildId: req.params.guildId });
        res.status(500).json({ error: 'Failed to fetch emojis and stickers' });
    }
});

/**
 * POST /emojis — Upload a new emoji
 */
router.post('/emojis', emojiUpload.single('file'), handleUploadError, async (req, res) => {
    try {
        const guild = req.guildObject;
        if (!guild) return res.status(404).json({ error: 'Guild not found' });

        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const name = req.body.name?.trim();
        if (!name || !/^[a-zA-Z0-9_]{2,32}$/.test(name)) {
            return res.status(400).json({ error: 'Emoji name must be 2-32 characters (letters, numbers, underscores only)' });
        }

        const createOptions = {
            attachment: req.file.buffer,
            name,
            reason: `Uploaded via dashboard by ${req.user?.username || 'unknown'}`
        };

        // Optional role restrictions
        if (req.body.roles) {
            try {
                const roles = JSON.parse(req.body.roles);
                if (Array.isArray(roles) && roles.length > 0) {
                    createOptions.roles = roles;
                }
            } catch { /* ignore invalid roles JSON */ }
        }

        const emoji = await guild.emojis.create(createOptions);

        logger.info(`[API EmojiManager] Emoji created: ${emoji.name} (${emoji.id}) in ${guild.name}`, { userId: req.user?.id });

        res.json({
            success: true,
            emoji: {
                id: emoji.id,
                name: emoji.name,
                animated: emoji.animated,
                url: emoji.imageURL({ size: 128, extension: emoji.animated ? 'gif' : 'webp' })
            }
        });
    } catch (error) {
        logger.error('[API EmojiManager] Error creating emoji:', { error: error.message, guildId: req.params.guildId });
        const msg = error.code === 30008 ? 'Maximum number of emojis reached for this server'
            : error.code === 50035 ? 'Invalid image or name — check file format and size'
            : error.message || 'Failed to create emoji';
        res.status(400).json({ error: msg });
    }
});

/**
 * PATCH /emojis/:emojiId — Rename an emoji or update role restrictions
 */
router.patch('/emojis/:emojiId', async (req, res) => {
    try {
        const guild = req.guildObject;
        if (!guild) return res.status(404).json({ error: 'Guild not found' });

        const emoji = await guild.emojis.fetch(req.params.emojiId);
        if (!emoji) return res.status(404).json({ error: 'Emoji not found' });
        if (emoji.managed) return res.status(400).json({ error: 'Cannot edit managed emojis (from integrations)' });

        const updates = {};
        if (req.body.name?.trim()) {
            const name = req.body.name.trim();
            if (!/^[a-zA-Z0-9_]{2,32}$/.test(name)) {
                return res.status(400).json({ error: 'Emoji name must be 2-32 characters (letters, numbers, underscores only)' });
            }
            updates.name = name;
        }

        if (req.body.roles !== undefined) {
            try {
                updates.roles = JSON.parse(req.body.roles);
            } catch { /* ignore */ }
        }

        updates.reason = `Edited via dashboard by ${req.user?.username || 'unknown'}`;

        await guild.emojis.edit(emoji, updates);

        logger.info(`[API EmojiManager] Emoji edited: ${emoji.name} (${emoji.id}) in ${guild.name}`, { userId: req.user?.id });

        res.json({ success: true });
    } catch (error) {
        logger.error('[API EmojiManager] Error editing emoji:', { error: error.message, guildId: req.params.guildId });
        res.status(400).json({ error: error.message || 'Failed to edit emoji' });
    }
});

/**
 * DELETE /emojis/:emojiId — Delete an emoji
 */
router.delete('/emojis/:emojiId', async (req, res) => {
    try {
        const guild = req.guildObject;
        if (!guild) return res.status(404).json({ error: 'Guild not found' });

        const emoji = await guild.emojis.fetch(req.params.emojiId);
        if (!emoji) return res.status(404).json({ error: 'Emoji not found' });
        if (emoji.managed) return res.status(400).json({ error: 'Cannot delete managed emojis (from integrations)' });

        const emojiName = emoji.name;
        await guild.emojis.delete(emoji, `Deleted via dashboard by ${req.user?.username || 'unknown'}`);

        logger.info(`[API EmojiManager] Emoji deleted: ${emojiName} in ${guild.name}`, { userId: req.user?.id });

        res.json({ success: true });
    } catch (error) {
        logger.error('[API EmojiManager] Error deleting emoji:', { error: error.message, guildId: req.params.guildId });
        res.status(400).json({ error: error.message || 'Failed to delete emoji' });
    }
});

/**
 * POST /stickers — Upload a new sticker
 */
router.post('/stickers', stickerUpload.single('file'), handleUploadError, async (req, res) => {
    try {
        const guild = req.guildObject;
        if (!guild) return res.status(404).json({ error: 'Guild not found' });

        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const name = req.body.name?.trim();
        if (!name || name.length < 2 || name.length > 30) {
            return res.status(400).json({ error: 'Sticker name must be 2-30 characters' });
        }

        const tags = req.body.tags?.trim();
        if (!tags) {
            return res.status(400).json({ error: 'Related emoji tag is required' });
        }

        const sticker = await guild.stickers.create({
            file: req.file.buffer,
            name,
            tags,
            description: req.body.description?.trim() || '',
            reason: `Uploaded via dashboard by ${req.user?.username || 'unknown'}`
        });

        logger.info(`[API EmojiManager] Sticker created: ${sticker.name} (${sticker.id}) in ${guild.name}`, { userId: req.user?.id });

        res.json({
            success: true,
            sticker: {
                id: sticker.id,
                name: sticker.name,
                url: sticker.url
            }
        });
    } catch (error) {
        logger.error('[API EmojiManager] Error creating sticker:', { error: error.message, guildId: req.params.guildId });
        const msg = error.code === 30039 ? 'Maximum number of stickers reached for this server'
            : error.code === 50035 ? 'Invalid image — stickers must be PNG/APNG, 320x320px recommended'
            : error.message || 'Failed to create sticker';
        res.status(400).json({ error: msg });
    }
});

/**
 * PATCH /stickers/:stickerId — Edit sticker name/description/tags
 */
router.patch('/stickers/:stickerId', async (req, res) => {
    try {
        const guild = req.guildObject;
        if (!guild) return res.status(404).json({ error: 'Guild not found' });

        const sticker = await guild.stickers.fetch(req.params.stickerId);
        if (!sticker) return res.status(404).json({ error: 'Sticker not found' });

        const updates = {};
        if (req.body.name?.trim()) {
            const name = req.body.name.trim();
            if (name.length < 2 || name.length > 30) {
                return res.status(400).json({ error: 'Sticker name must be 2-30 characters' });
            }
            updates.name = name;
        }
        if (req.body.tags !== undefined) updates.tags = req.body.tags.trim();
        if (req.body.description !== undefined) updates.description = req.body.description.trim();
        updates.reason = `Edited via dashboard by ${req.user?.username || 'unknown'}`;

        await guild.stickers.edit(sticker, updates);

        logger.info(`[API EmojiManager] Sticker edited: ${sticker.name} (${sticker.id}) in ${guild.name}`, { userId: req.user?.id });

        res.json({ success: true });
    } catch (error) {
        logger.error('[API EmojiManager] Error editing sticker:', { error: error.message, guildId: req.params.guildId });
        res.status(400).json({ error: error.message || 'Failed to edit sticker' });
    }
});

/**
 * DELETE /stickers/:stickerId — Delete a sticker
 */
router.delete('/stickers/:stickerId', async (req, res) => {
    try {
        const guild = req.guildObject;
        if (!guild) return res.status(404).json({ error: 'Guild not found' });

        const sticker = await guild.stickers.fetch(req.params.stickerId);
        if (!sticker) return res.status(404).json({ error: 'Sticker not found' });

        const stickerName = sticker.name;
        await guild.stickers.delete(sticker, `Deleted via dashboard by ${req.user?.username || 'unknown'}`);

        logger.info(`[API EmojiManager] Sticker deleted: ${stickerName} in ${guild.name}`, { userId: req.user?.id });

        res.json({ success: true });
    } catch (error) {
        logger.error('[API EmojiManager] Error deleting sticker:', { error: error.message, guildId: req.params.guildId });
        res.status(400).json({ error: error.message || 'Failed to delete sticker' });
    }
});

export default router;
