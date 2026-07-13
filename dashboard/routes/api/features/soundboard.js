/**
 * Soundboard API — list / upload (drag-and-drop) / delete a guild's sounds.
 * Mounted at /api/guilds/:guildId/soundboard (already auth + guild-admin gated
 * by api/index.js). Shares the vc_sound_files library + sounds/<guildId>/ store
 * used by the /soundboard Discord command.
 */
import express from 'express';
import multer from 'multer';
import logger from '../../../../utils/logger.js';
import {
  listSounds, saveFromBuffer, deleteSoundById, ALLOWED_EXT, MAX_BYTES,
} from '../../../../core/soundboard-manager.js';

const router = express.Router({ mergeParams: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `File too large. Max ${MAX_BYTES / 1024 / 1024}MB.` });
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
}

// GET — list this guild's sounds
router.get('/sounds', async (req, res) => {
  try {
    const sounds = await listSounds(req.params.guildId);
    res.json({
      success: true,
      maxBytes: MAX_BYTES,
      allowedExt: ALLOWED_EXT,
      sounds: sounds.map(s => ({ id: s.id, name: s.name, emoji: s.emoji, play_count: s.play_count || 0 })),
    });
  } catch (e) {
    logger.error('[API Soundboard GET] ' + e.message);
    res.status(500).json({ error: 'Failed to load sounds' });
  }
});

// POST — upload a new sound (multipart: file + name + emoji)
router.post('/sounds', upload.single('file'), handleUploadError, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const name = (req.body.name || '').trim() || req.file.originalname.replace(/\.[^.]+$/, '');
    const emoji = (req.body.emoji || '').trim() || null;
    const r = await saveFromBuffer(req.params.guildId, name, req.file.buffer, req.file.originalname, req.user?.id || 'dashboard', emoji);
    if (!r.ok) return res.status(400).json({ error: r.reason });
    res.json({ success: true, sound: { id: r.sound.id, name: r.sound.name, emoji: r.sound.emoji, play_count: r.sound.play_count || 0 } });
  } catch (e) {
    logger.error('[API Soundboard POST] ' + e.message);
    res.status(500).json({ error: 'Failed to save sound' });
  }
});

// DELETE — remove a sound by id
router.delete('/sounds/:id', async (req, res) => {
  try {
    const r = await deleteSoundById(req.params.guildId, req.params.id);
    if (!r.ok) return res.status(404).json({ error: r.reason });
    res.json({ success: true });
  } catch (e) {
    logger.error('[API Soundboard DELETE] ' + e.message);
    res.status(500).json({ error: 'Failed to delete sound' });
  }
});

export default router;
