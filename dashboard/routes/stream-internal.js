// Localhost-only, secret-gated endpoint the relay calls at go-live.
import express from 'express';
import { resolveDestinations } from '../services/platforms/resolver.js';
import logger from '../../utils/logger.js';

const router = express.Router();
const SECRET = process.env.RELAY_INTERNAL_SECRET;

router.post('/internal/resolve-destinations', async (req, res) => {
  if (!SECRET || req.headers['x-relay-secret'] !== SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const streamKey = req.body && req.body.streamKey;
  if (!streamKey) return res.status(400).json({ error: 'streamKey required' });
  try {
    const destinations = await resolveDestinations({}, streamKey);
    res.json({ destinations });
  } catch (err) {
    logger.error('[stream-internal] resolve failed: ' + err.message);
    res.status(500).json({ error: 'resolve_failed' });
  }
});

export default router;
