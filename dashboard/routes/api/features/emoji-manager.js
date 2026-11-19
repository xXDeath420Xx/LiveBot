/**
 * Emoji & Sticker Manager API
 * Proxies CRUD operations to Discord API for server emojis and stickers
 */

import express from 'express';
import multer from 'multer';
import logger from '../../../../utils/logger.js';
import { generateImage } from '../../../../utils/image-generation.js';
import { stickerPrompt, makeEmote, emoteName, prepareEmote } from '../../../../core/emote-pack.js';
import { splitSheet } from '../../../../core/sprite-sheet.js';
import { EFFECTS, animateEmote, animationAvailable } from '../../../../core/emote-animate.js';

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

// A sheet holds many emotes at once, so it is allowed to be a real image.
const sheetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/webp'];
        cb(allowed.includes(file.mimetype) ? null : new Error('Sheets must be PNG, JPEG or WebP'),
            allowed.includes(file.mimetype));
    },
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
 * POST /generate — draw a new emoji, but do not add it yet.
 *
 * Two steps on purpose. Emoji slots are scarce — fifty at boost tier zero — and
 * a generator that put every attempt straight into the server would fill it with
 * rejects. This returns the picture; POST /emojis/generated is what spends a slot.
 *
 * An optional reference photo is passed through to the generator, which is how
 * someone's actual dog becomes a sticker of that dog rather than of a dog.
 */
router.post('/generate', emojiUpload.single('reference'), handleUploadError, async (req, res) => {
    try {
        const subject = req.body.subject?.trim();
        if (!subject) return res.status(400).json({ error: 'Describe what the emoji should show' });
        if (subject.length > 300) return res.status(400).json({ error: 'Keep the description under 300 characters' });

        const reference = req.file
            ? { buffer: req.file.buffer, contentType: req.file.mimetype }
            : null;
        const prompt = reference
            ? `${stickerPrompt(subject)} Keep the same colours, markings and features as the photograph.`
            : stickerPrompt(subject);

        const art = await generateImage({ prompt, reference, aspect: 'square' });
        const emote = await makeEmote(art.buffer);

        logger.info(`[API EmojiManager] Generated an emoji candidate for guild ${req.params.guildId}`,
            { userId: req.user?.id, provider: art.provider });

        res.json({
            success: true,
            png: `data:image/png;base64,${emote.buffer.toString('base64')}`,
            bytes: emote.bytes,
            cut: emote.cut,
            suggestedName: emoteName(subject.split(/\s+/).slice(0, 3).join('_')) || 'new_emote',
        });
    } catch (error) {
        logger.error('[API EmojiManager] Generation failed:', { error: error.message, guildId: req.params.guildId });
        res.status(502).json({ error: `Could not draw that: ${error.message}` });
    }
});

/**
 * POST /split-sheet — cut one image holding many emotes into separate ones.
 *
 * Sticker packs arrive as a single picture with a dozen emotes laid out on a flat
 * field. Cropping those by hand is the whole job; doing it here turns it into one
 * upload. Nothing is added to the server — the pieces come back for naming, the
 * same two-step as /generate.
 */
router.post('/split-sheet', sheetUpload.single('sheet'), handleUploadError, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Upload the sheet image' });

        const pieces = await splitSheet(req.file.buffer);
        if (!pieces.length) {
            return res.status(422).json({
                error: 'Nothing could be found on that sheet. It needs the emotes spaced out on a plain background.',
            });
        }
        if (pieces.length > 60) {
            return res.status(422).json({ error: `That split into ${pieces.length} pieces, which is more than a sheet should hold` });
        }

        const emotes = [];
        for (const piece of pieces) {
            const png = await prepareEmote(piece.buffer);
            emotes.push({ png: `data:image/png;base64,${png.toString('base64')}`, bytes: png.length });
        }

        logger.info(`[API EmojiManager] Sheet split into ${emotes.length} for guild ${req.params.guildId}`,
            { userId: req.user?.id });
        res.json({ success: true, emotes });
    } catch (error) {
        logger.error('[API EmojiManager] Sheet split failed:', { error: error.message });
        res.status(500).json({ error: `Could not split that sheet: ${error.message}` });
    }
});

/**
 * GET /effects — the animation effects on offer, and whether they can be made.
 */
router.get('/effects', async (req, res) => {
    const available = await animationAvailable();
    res.json({
        success: true,
        available,
        effects: Object.entries(EFFECTS).map(([id, e]) => ({ id, label: e.label })),
    });
});

/**
 * POST /animate — make a still emoji move.
 *
 * Takes either an emoji already in this server (`emojiId`) or an uploaded image,
 * and one effect. Returns the GIF for approval; adding it is a separate call, as
 * with everything else here. Animated emoji have their own fifty slots, so this
 * never costs a static one.
 */
router.post('/animate', emojiUpload.single('image'), handleUploadError, async (req, res) => {
    try {
        const effect = String(req.body.effect || '');
        if (!EFFECTS[effect]) return res.status(400).json({ error: 'Pick one of the listed effects' });
        if (!await animationAvailable()) {
            return res.status(503).json({ error: 'Animation is unavailable on this server (ffmpeg is missing)' });
        }

        let source = req.file?.buffer || null;
        let suggested = '';
        if (!source) {
            const guild = req.guildObject;
            if (!guild) return res.status(404).json({ error: 'Guild not found' });
            const emoji = guild.emojis.cache.get(String(req.body.emojiId || ''));
            if (!emoji) return res.status(400).json({ error: 'Pick an emoji to animate, or upload an image' });
            if (emoji.animated) return res.status(400).json({ error: 'That one already moves' });

            const url = emoji.imageURL({ size: 128, extension: 'png' });
            const fetched = await fetch(url);
            if (!fetched.ok) return res.status(502).json({ error: 'Could not fetch that emoji from Discord' });
            source = Buffer.from(await fetched.arrayBuffer());
            /* Name it after the original plus the effect. Two emoji cannot share
               a name, and ":kirby_lounge: but spinning" is what it is. */
            suggested = `${emoji.name}_${effect}`.slice(0, 32);
        }

        const made = await animateEmote(source, effect);
        res.json({
            success: true,
            gif: `data:image/gif;base64,${made.buffer.toString('base64')}`,
            bytes: made.bytes,
            reduced: !!made.reduced,
            suggestedName: suggested,
        });
    } catch (error) {
        logger.error('[API EmojiManager] Animation failed:', { error: error.message });
        res.status(500).json({ error: `Could not animate that: ${error.message}` });
    }
});

/**
 * POST /emojis/generated — add a picture that came back from /generate.
 *
 * Separate from the file upload because there is no file: the client is handing
 * back the base64 it was just given, rather than re-uploading it as multipart.
 */
router.post('/emojis/generated', async (req, res) => {
    try {
        const guild = req.guildObject;
        if (!guild) return res.status(404).json({ error: 'Guild not found' });

        const name = req.body.name?.trim();
        if (!name || !/^[a-zA-Z0-9_]{2,32}$/.test(name)) {
            return res.status(400).json({ error: 'Emoji name must be 2-32 characters (letters, numbers, underscores only)' });
        }
        const data = String(req.body.png || req.body.gif || '');
        const base64 = data.startsWith('data:image/png;base64,') ? data.slice(22)
            : data.startsWith('data:image/gif;base64,') ? data.slice(22)
                : null;
        if (!base64) return res.status(400).json({ error: 'That is not a generated image' });

        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length > 256 * 1024) return res.status(400).json({ error: 'Image is over 256 KiB' });

        const emoji = await guild.emojis.create({
            attachment: buffer,
            name,
            reason: `Generated via dashboard by ${req.user?.username || 'unknown'}`,
        });

        logger.info(`[API EmojiManager] Generated emoji added: ${emoji.name} (${emoji.id}) in ${guild.name}`,
            { userId: req.user?.id });

        res.json({
            success: true,
            emoji: {
                id: emoji.id, name: emoji.name, animated: emoji.animated,
                url: emoji.imageURL({ size: 128, extension: 'webp' }),
            },
        });
    } catch (error) {
        logger.error('[API EmojiManager] Error adding generated emoji:', { error: error.message });
        const msg = error.code === 30008 ? 'This server has no emoji slots left'
            : error.code === 50035 ? 'Discord rejected the image or the name'
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
