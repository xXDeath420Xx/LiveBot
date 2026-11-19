/**
 * VC sound drop clips, managed from the dashboard (until 2026-11-18 only /admin vcsounds addsound could
 * add one, and a server that switched drops on without sounds got silence with no hint why).
 *   GET    /api/guilds/:guildId/vc-sounds                 this server's clips + whether drops are on
 *   PUT    /api/guilds/:guildId/vc-sounds/:name           upload/replace a clip (raw audio body, max 5 MB)
 *   PATCH  /api/guilds/:guildId/vc-sounds/:name           { enabled }
 *   DELETE /api/guilds/:guildId/vc-sounds/:name
 *   GET    /api/guilds/:guildId/vc-sounds/:name/audio     the file, for the page's preview player
 * Files live where the slash command puts them: sounds/<guildId>/<name><ext>, same table (vc_sound_files).
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });
const SOUNDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'sounds');
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CLIPS = 50;
const NAME = /^[a-z0-9_-]{1,40}$/;
const TYPES = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };

/** Recognise the audio format from the file's first bytes rather than trusting a filename or header. */
function sniff(buf) {
    if (buf.length < 12) return null;
    const head = buf.subarray(0, 4).toString('latin1');
    if (head === 'OggS') return '.ogg';
    if (head === 'fLaC') return '.flac';
    if (head === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return '.wav';
    if (buf.subarray(0, 3).toString('latin1') === 'ID3') return '.mp3';
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return '.mp3';   // MPEG frame sync
    return null;
}

const guildDir = (guildId) => path.join(SOUNDS_DIR, guildId);
/** Only ever touch files inside this server's own folder. */
function insideGuildDir(guildId, file) {
    const rel = path.relative(guildDir(guildId), path.resolve(file || ''));
    return !!file && !rel.startsWith('..') && !path.isAbsolute(rel);
}

router.get('/', async (req, res) => {
    const { guildId } = req.params;
    try {
        const [rows] = await pool.execute(
            'SELECT name, enabled, play_count, added_by, created_at, file_path FROM vc_sound_files WHERE guild_id = ? ORDER BY name',
            [guildId]);
        const [[cfg]] = await pool.execute('SELECT enabled FROM vc_sound_config WHERE guild_id = ?', [guildId]);
        res.json({
            dropsEnabled: !!cfg?.enabled,
            sounds: rows.map(r => ({
                name: r.name, enabled: !!r.enabled, plays: r.play_count || 0, addedBy: r.added_by,
                createdAt: r.created_at, missing: !fs.existsSync(r.file_path),
            })),
            limits: { maxBytes: MAX_BYTES, maxClips: MAX_CLIPS, types: Object.keys(TYPES) },
        });
    } catch (error) {
        logger.error('[VCSounds API] list failed', { error: error.message });
        res.status(500).json({ error: 'Could not load the clips.' });
    }
});

router.put('/:name', express.raw({ type: () => true, limit: MAX_BYTES + 1024 }), async (req, res) => {
    const { guildId } = req.params;
    const name = String(req.params.name || '').toLowerCase();
    if (!NAME.test(name)) return res.status(400).json({ error: 'Name: letters, numbers, - and _ only, up to 40 characters.' });
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ error: 'No file received.' });
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'That file is over 5 MB.' });
    const ext = sniff(buf);
    if (!ext) return res.status(415).json({ error: 'That is not an MP3, WAV, OGG or FLAC file.' });
    try {
        const [[count]] = await pool.execute(
            'SELECT COUNT(*) AS n, SUM(name = ?) AS mine FROM vc_sound_files WHERE guild_id = ?', [name, guildId]);
        if (!Number(count.mine) && Number(count.n) >= MAX_CLIPS) return res.status(409).json({ error: `A server can have up to ${MAX_CLIPS} clips.` });

        fs.mkdirSync(guildDir(guildId), { recursive: true });
        // Replacing a clip with a different format leaves no stale file behind.
        for (const e of Object.keys(TYPES)) {
            const old = path.join(guildDir(guildId), name + e);
            if (e !== ext && fs.existsSync(old)) fs.unlinkSync(old);
        }
        const file = path.join(guildDir(guildId), name + ext);
        fs.writeFileSync(file, buf);
        await pool.execute(
            `INSERT INTO vc_sound_files (guild_id, name, file_path, added_by) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE file_path = VALUES(file_path), enabled = TRUE`,
            [guildId, name, file, String(req.user?.id || '0')]);
        res.json({ ok: true, name });
    } catch (error) {
        logger.error('[VCSounds API] upload failed', { error: error.message });
        res.status(500).json({ error: 'Could not save the clip.' });
    }
});

router.patch('/:name', async (req, res) => {
    const { guildId, name } = req.params;
    const enabled = req.body?.enabled ? 1 : 0;
    try {
        const [r] = await pool.execute('UPDATE vc_sound_files SET enabled = ? WHERE guild_id = ? AND name = ?', [enabled, guildId, name]);
        if (!r.affectedRows) return res.status(404).json({ error: 'No clip with that name.' });
        res.json({ ok: true, enabled: !!enabled });
    } catch (error) {
        logger.error('[VCSounds API] toggle failed', { error: error.message });
        res.status(500).json({ error: 'Could not update the clip.' });
    }
});

router.delete('/:name', async (req, res) => {
    const { guildId, name } = req.params;
    try {
        const [[row]] = await pool.execute('SELECT file_path FROM vc_sound_files WHERE guild_id = ? AND name = ?', [guildId, name]);
        if (!row) return res.status(404).json({ error: 'No clip with that name.' });
        await pool.execute('DELETE FROM vc_sound_files WHERE guild_id = ? AND name = ?', [guildId, name]);
        if (insideGuildDir(guildId, row.file_path) && fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
        res.json({ ok: true });
    } catch (error) {
        logger.error('[VCSounds API] delete failed', { error: error.message });
        res.status(500).json({ error: 'Could not remove the clip.' });
    }
});

router.get('/:name/audio', async (req, res) => {
    const { guildId, name } = req.params;
    try {
        const [[row]] = await pool.execute('SELECT file_path FROM vc_sound_files WHERE guild_id = ? AND name = ?', [guildId, name]);
        if (!row || !insideGuildDir(guildId, row.file_path) || !fs.existsSync(row.file_path)) return res.status(404).end();
        res.type(TYPES[path.extname(row.file_path).toLowerCase()] || 'application/octet-stream');
        res.set('Cache-Control', 'private, max-age=300');
        fs.createReadStream(row.file_path).pipe(res);
    } catch (error) {
        logger.error('[VCSounds API] audio failed', { error: error.message });
        res.status(500).end();
    }
});

export default router;
