/**
 * Guild Soundboard sounds API — thin wrapper over Discord's
 * `/guilds/{id}/soundboard-sounds` via discord.js's `guild.soundboardSounds`.
 *
 * CRUD operations:
 *   GET    /                 — list every custom sound on the guild
 *   POST   /                 — create one (name, sound base64, volume, emoji)
 *   PATCH  /:soundId         — rename / re-emoji / adjust volume
 *   DELETE /:soundId         — remove a sound
 *
 * Sound size limit: 512 KB raw MP3/OGG (Discord's cap). We rely on Discord's
 * server-side validation for rejects (bad format, oversized) rather than
 * duplicating the check here.
 *
 * All routes gated by `apiCheckGuildAdmin` at the parent router.
 */
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;

function serialiseSound(s) {
    return {
        id: s.soundId ?? s.id,
        guildId: s.guildId ?? null,
        name: s.name,
        volume: s.volume,
        emoji: s.emojiId
            ? { id: s.emojiId, name: s.emojiName ?? null, animated: !!s.emojiAnimated }
            : (s.emojiName ? { id: null, name: s.emojiName, animated: false } : null),
        available: s.available !== false,
        userId: s.user?.id ?? s.userId ?? null,
    };
}

function requireManageExpressions(req, res) {
    const me = req.guildObject?.members?.me;
    // Discord treats soundboard sounds as "expressions" for permission purposes.
    const ok = me?.permissions?.any(
        PermissionFlagsBits.CreateGuildExpressions | PermissionFlagsBits.ManageGuildExpressions
    );
    if (!ok) {
        res.status(403).json({ error: 'The bot needs Create Expressions or Manage Expressions to touch soundboard sounds.' });
        return false;
    }
    return true;
}

/** GET / — list all sounds. */
router.get('/', async (req, res) => {
    try {
        if (!requireManageExpressions(req, res)) return;
        const sounds = await req.guildObject.soundboardSounds.fetch();
        res.json({ sounds: [...sounds.values()].map(serialiseSound) });
    } catch (err) {
        logger.error('[API soundboard GET] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to fetch sounds' });
    }
});

/** POST / — upload a new sound. Body: { name, sound (data URL or base64), volume, emoji? } */
router.post('/', async (req, res) => {
    try {
        if (!requireManageExpressions(req, res)) return;
        const { name, sound, volume, emoji, reason } = req.body || {};
        if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'A name is required (2–32 chars).' });
        if (typeof sound !== 'string' || !sound) return res.status(400).json({ error: 'A sound payload is required (base64 or data URL).' });

        const opts = {
            name: name.trim().slice(0, 32),
            sound,
        };
        if (typeof volume === 'number' && volume >= 0 && volume <= 1) opts.volume = volume;
        if (emoji) {
            if (emoji.id && SNOWFLAKE.test(String(emoji.id))) opts.emojiId = String(emoji.id);
            else if (emoji.name) opts.emojiName = String(emoji.name);
        }
        if (reason) opts.reason = String(reason).slice(0, 512);

        const created = await req.guildObject.soundboardSounds.create(opts);
        logger.info('[API soundboard POST] created', { guildId: req.params.guildId, soundId: created.soundId, by: req.user?.id });
        res.json({ success: true, sound: serialiseSound(created) });
    } catch (err) {
        if (err?.code === 50013) return res.status(403).json({ error: 'Discord refused — missing permission.' });
        if (err?.code === 50046) return res.status(400).json({ error: 'Invalid sound file (format must be MP3 or OGG, under 512 KB, 5.2 s or shorter).' });
        logger.error('[API soundboard POST] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to create sound' });
    }
});

/** PATCH /:soundId — rename / recolor / change emoji / change volume. */
router.patch('/:soundId', async (req, res) => {
    try {
        if (!requireManageExpressions(req, res)) return;
        const soundId = req.params.soundId;
        if (!SNOWFLAKE.test(String(soundId))) return res.status(400).json({ error: 'Invalid sound id.' });

        const patch = {};
        if (req.body?.name !== undefined) {
            if (typeof req.body.name !== 'string') return res.status(400).json({ error: 'name must be a string.' });
            patch.name = req.body.name.trim().slice(0, 32);
        }
        if (typeof req.body?.volume === 'number' && req.body.volume >= 0 && req.body.volume <= 1) patch.volume = req.body.volume;
        if (req.body?.emoji !== undefined) {
            if (req.body.emoji === null) { patch.emojiId = null; patch.emojiName = null; }
            else if (req.body.emoji?.id && SNOWFLAKE.test(String(req.body.emoji.id))) patch.emojiId = String(req.body.emoji.id);
            else if (req.body.emoji?.name) patch.emojiName = String(req.body.emoji.name);
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to patch.' });
        if (req.body?.reason) patch.reason = String(req.body.reason).slice(0, 512);

        const edited = await req.guildObject.soundboardSounds.edit(soundId, patch);
        logger.info('[API soundboard PATCH] updated', { guildId: req.params.guildId, soundId, by: req.user?.id });
        res.json({ success: true, sound: serialiseSound(edited) });
    } catch (err) {
        if (err?.code === 10109) return res.status(404).json({ error: 'That sound no longer exists.' });
        if (err?.code === 50013) return res.status(403).json({ error: 'Discord refused — missing permission.' });
        logger.error('[API soundboard PATCH] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to update sound' });
    }
});

/** DELETE /:soundId — remove a sound. */
router.delete('/:soundId', async (req, res) => {
    try {
        if (!requireManageExpressions(req, res)) return;
        const soundId = req.params.soundId;
        if (!SNOWFLAKE.test(String(soundId))) return res.status(400).json({ error: 'Invalid sound id.' });
        await req.guildObject.soundboardSounds.delete(soundId, req.body?.reason ? String(req.body.reason).slice(0, 512) : undefined);
        logger.info('[API soundboard DELETE] removed', { guildId: req.params.guildId, soundId, by: req.user?.id });
        res.json({ success: true });
    } catch (err) {
        if (err?.code === 10109) return res.status(404).json({ error: 'That sound no longer exists.' });
        if (err?.code === 50013) return res.status(403).json({ error: 'Discord refused — missing permission.' });
        logger.error('[API soundboard DELETE] failed', { err: err.message });
        res.status(500).json({ error: err?.message ?? 'Failed to delete sound' });
    }
});

export default router;
