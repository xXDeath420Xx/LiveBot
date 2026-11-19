// cinema/index.js
// Standalone PM2 process. Logs in the selfbot, serves a loopback-only control
// API to the main bot, mirrors live state into the shared DB, and runs an
// idle/health watchdog. Loads NO bot token — only its own cinema/.env.

import dotenv from 'dotenv';
dotenv.config({ path: new URL('.env', import.meta.url) });
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { WebSocket } from 'ws';
import { Client } from 'discord.js-selfbot-v13';
import pool from '../utils/db.js';
import { CinemaStreamer } from './streamer.js';

globalThis.WebSocket ??= WebSocket;

const PORT = Number(process.env.CINEMA_PORT || 8099);
const SECRET = process.env.CINEMA_API_SECRET || '';
if (!SECRET) { console.error('[cinema] CINEMA_API_SECRET must be set — refusing to start'); process.exit(1); }
const SECRET_BUF = Buffer.from(SECRET);
const IDLE_MIN = Number(process.env.CINEMA_IDLE_TIMEOUT_MIN || 10);
const ENC = { width: 1280, height: 720, fps: 30, bitrateKbps: 2500 };

const client = new Client();
const streamer = new CinemaStreamer(client, ENC);

// --- shared-DB state mirror ---
async function writeState() {
  const s = streamer.state();
  if (!s.busy) { await pool.execute('DELETE FROM cinema_state WHERE id = 1'); return; }
  // NOTE: the UPDATE clause MUST refresh item_id/item_name (not just status/position)
  // — otherwise a seamless auto-advance to the next episode leaves the DB (and the
  // bot's Now-Playing panel) showing the previous episode.
  await pool.execute(
    `INSERT INTO cinema_state (id, guild_id, channel_id, voice_channel_id, item_id, item_name,
        started_by, audio_index, sub_index, status, position_secs, queue_remaining, up_next)
     VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
        item_id=VALUES(item_id), item_name=VALUES(item_name),
        status=VALUES(status), position_secs=VALUES(position_secs),
        queue_remaining=VALUES(queue_remaining), up_next=VALUES(up_next)`,
    [s.session.guildId, s.session.channelId ?? '', s.session.voiceChannelId,
     s.session.itemId, s.session.itemName, s.session.startedBy ?? '',
     s.session.audioIndex ?? null, s.session.subIndex ?? null, s.status, s.positionSecs,
     s.queueRemaining ?? 0, s.upNext?.itemName ?? null]
  );
}

async function reconcileOnBoot() {
  if (!streamer.isBusy()) {
    await pool.execute('DELETE FROM cinema_state WHERE id = 1').catch(() => {});
    console.log('[cinema] cleared orphaned cinema_state lock on boot');
  }
}

streamer.onEnd = async () => { await writeState().catch(() => {}); };
streamer.onAdvance = async () => {
  await writeState().catch(() => {});
  const s = streamer.state();
  console.log(`[cinema] auto-advanced -> ${s.session?.itemName} (${s.queueRemaining} left in queue)`);
};
streamer.onError = (e) => console.error('[cinema] stream error:', e?.message || e);

// --- loopback control API ---
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const provided = Buffer.from(String(req.headers['x-cinema-secret'] || ''));
  const ok = provided.length === SECRET_BUF.length && timingSafeEqual(provided, SECRET_BUF);
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.post('/play', async (req, res) => {
  try {
    if (streamer.isBusy()) {
      const s = streamer.state();
      return res.status(409).json({ error: 'busy', session: s.session });
    }
    const b = req.body;
    streamer.session = null;
    await streamer.play({
      guildId: b.guildId, voiceChannelId: b.voiceChannelId,
      itemId: b.itemId, itemName: b.itemName,
      audioIndex: b.audioIndex ?? null, subIndex: b.subIndex ?? null,
      queue: b.queue, // optional ordered playlist [{itemId,itemName}]
    });
    Object.assign(streamer.session, { channelId: b.channelId, startedBy: b.startedBy });
    await writeState();
    res.json({ ok: true, queueLength: streamer.state().queueLength });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Skip to the next queued item. Returns { done:true } if nothing was queued after.
app.post('/next', async (_req, res) => {
  try {
    const r = await streamer.playNext();
    await writeState();
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

for (const verb of ['pause', 'resume', 'stop']) {
  app.post(`/${verb}`, async (_req, res) => {
    try { await streamer[verb](); await writeState(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}

app.post('/seek', async (req, res) => {
  try { await streamer.seek(Number(req.body.secs || 0)); await writeState(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/status', (_req, res) => res.json(streamer.state()));

app.get('/guilds', (_req, res) => {
  const guilds = [...client.guilds.cache.values()].map((g) => ({
    id: g.id, name: g.name,
    voiceChannels: [...g.channels.cache.values()]
      .filter((c) => c.type === 2).map((c) => ({ id: c.id, name: c.name })),
  }));
  res.json({ count: guilds.length, guilds });
});

app.post('/join', async (req, res) => {
  try {
    const invite = req.body?.invite;
    if (!invite) return res.status(400).json({ error: 'invite required' });
    await client.acceptInvite(invite, { bypassOnboarding: true, bypassVerify: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- watchdog: idle auto-stop + periodic position mirror ---
setInterval(async () => {
  if (!streamer.isBusy()) return;
  await writeState().catch(() => {});
  try {
    const guild = await client.guilds.fetch(streamer.session.guildId);
    const vc = await guild.channels.fetch(streamer.session.voiceChannelId);
    const humans = vc?.members?.filter((m) => !m.user.bot && m.id !== client.user.id).size ?? 0;
    streamer._emptySince = humans === 0 ? (streamer._emptySince ?? Date.now()) : null;
    if (streamer._emptySince && Date.now() - streamer._emptySince > IDLE_MIN * 60_000) {
      console.log('[cinema] idle timeout — stopping');
      await streamer.stop(); await writeState();
    }
  } catch { /* ignore transient fetch errors */ }
}, 15_000);

client.on('ready', () => console.log(`[cinema] selfbot ready as ${client.user.tag}`));
client.login(process.env.CINEMA_USER_TOKEN)
  .then(async () => {
    await reconcileOnBoot();
    app.listen(PORT, '127.0.0.1', () => console.log(`[cinema] control API on 127.0.0.1:${PORT}`));
  })
  .catch((e) => { console.error('[cinema] login failed:', e.message); process.exit(1); });

// Safety net: a throw from the streaming library (e.g. DAVE/voice protocol edge
// cases) must never silently wedge the service. Log and keep serving.
process.on('uncaughtException', (e) => console.error('[cinema] uncaughtException:', e?.stack || e));
process.on('unhandledRejection', (e) => console.error('[cinema] unhandledRejection:', e?.stack || e));

process.on('SIGTERM', async () => { try { await streamer.stop(); } catch {} process.exit(0); });
