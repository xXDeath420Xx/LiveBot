/**
 * Creator Showcase manager.
 *
 * A showcase channel lets creators drop their OWN music/video. To stop casual
 * downloading, we don't keep the file as a Discord attachment (those are always a
 * direct CDN download). Instead, on upload we:
 *   1. download the attachment,
 *   2. DELETE the original message (kills the CDN link — minimal exposure window),
 *   3. transcode to AES-128-encrypted HLS (chunked, no single file) + a watermark,
 *   4. post an embed linking to a tokenized player page on the dashboard.
 *
 * This is friction, not DRM — anything playable can still be screen/stream-captured.
 * It defeats casual right-click-save and segment-grabbing (segments are encrypted;
 * the key is served only behind a short-lived signed token).
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder } from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHOWCASE_DIR = path.join(__dirname, '..', 'data', 'showcase');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const MAX_BYTES = 250 * 1024 * 1024; // skip absurdly large uploads
const HLS_TIME = 6;

// ── token helpers (shared with dashboard/routes/showcase.js) ────────────────
const SECRET = crypto.createHash('sha256')
  .update((process.env.SHOWCASE_TOKEN_SECRET || process.env.BOT_ENCRYPTION_KEY || 'showcase') + ':showcase')
  .digest();

export function signToken(id, ttlMs = 3 * 3600 * 1000) {
  const exp = Date.now() + ttlMs;
  const mac = crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('base64url');
  return `${exp}.${mac}`;
}
export function verifyToken(id, t) {
  if (!t) return false;
  const [exp, mac] = String(t).split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const good = crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('base64url');
  try { return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good)); } catch { return false; }
}

// ── showcase-channel config (cached) ────────────────────────────────────────
let channelCache = null;
export function invalidateShowcaseCache() { channelCache = null; }
async function showcaseChannels() {
  if (channelCache) return channelCache;
  try {
    const [rows] = await pool.execute('SELECT channel_id FROM showcase_channels WHERE enabled = 1');
    channelCache = new Set(rows.map(r => r.channel_id));
  } catch { channelCache = new Set(); }
  return channelCache;
}

const AUDIO_EXT = /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|aiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|flv|wmv)$/i;
function classify(att) {
  const ct = (att.contentType || '').toLowerCase();
  const name = att.name || '';
  if (ct.startsWith('video/') || VIDEO_EXT.test(name)) return 'video';
  if (ct.startsWith('audio/') || AUDIO_EXT.test(name)) return 'audio';
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`)));
  });
}

// drawtext-safe watermark label
function watermark(name) {
  const safe = String(name || 'creator').replace(/[^a-zA-Z0-9_ .-]/g, '').slice(0, 32) || 'creator';
  return `@${safe} | CertiFried`;
}

async function transcodeToHls(inputPath, outDir, kind, creatorName) {
  await fsp.mkdir(outDir, { recursive: true });
  // AES-128 key + keyinfo (line1 = URI written into the m3u8, line2 = key file, line3 = IV)
  const keyPath = path.join(outDir, 'enc.key');
  await fsp.writeFile(keyPath, crypto.randomBytes(16));
  const iv = crypto.randomBytes(16).toString('hex');
  const keyInfoPath = path.join(outDir, 'keyinfo');
  await fsp.writeFile(keyInfoPath, `key\n${keyPath}\n${iv}\n`);

  const common = [
    '-hls_time', String(HLS_TIME), '-hls_playlist_type', 'vod',
    '-hls_key_info_file', keyInfoPath,
    '-hls_segment_filename', path.join(outDir, 'seg%03d.ts'),
    path.join(outDir, 'playlist.m3u8'),
  ];

  let args;
  if (kind === 'video') {
    const wm = `drawtext=fontfile=${FONT}:text='${watermark(creatorName)}':x=12:y=h-th-12:fontsize=18:fontcolor=white@0.85:box=1:boxcolor=black@0.45:boxborderw=8`;
    args = ['-hide_banner', '-loglevel', 'error', '-i', inputPath,
      '-vf', wm, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', ...common];
  } else {
    // audio-only HLS (the player page carries the attribution/watermark)
    args = ['-hide_banner', '-loglevel', 'error', '-i', inputPath,
      '-vn', '-c:a', 'aac', '-b:a', '192k', ...common];
  }
  await run('ffmpeg', args);
  // keyinfo no longer needed on disk after encode
  await fsp.unlink(keyInfoPath).catch(() => {});
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * messageCreate hook. Returns true if it consumed a showcase upload.
 */
export async function handleShowcaseMessage(message) {
  try {
    if (!message.guild || message.author?.bot) return false;
    if (!message.attachments?.size) return false;
    const channels = await showcaseChannels();
    if (!channels.has(message.channelId)) return false;

    const media = [...message.attachments.values()]
      .map(a => ({ att: a, kind: classify(a) }))
      .filter(x => x.kind);
    if (!media.length) return false; // not media — leave it for normal handling

    const tmpBase = path.join(SHOWCASE_DIR, '_tmp');
    await fsp.mkdir(tmpBase, { recursive: true });

    const creatorName = message.member?.displayName || message.author.username;
    const baseTitle = (message.content || '').trim().slice(0, 200);
    const posted = [];

    for (const { att, kind } of media) {
      if (att.size > MAX_BYTES) { logger.warn(`[Showcase] skip oversized ${att.name} (${att.size}b)`); continue; }
      const id = crypto.randomBytes(8).toString('hex');
      const tmpFile = path.join(tmpBase, `${id}-${(att.name || 'media').replace(/[^\w.-]/g, '_')}`);
      try {
        await downloadTo(att.url, tmpFile);
        await transcodeToHls(tmpFile, path.join(SHOWCASE_DIR, id), kind, creatorName);
        await pool.execute(
          'INSERT INTO showcase_items (id, guild_id, channel_id, creator_id, title, kind) VALUES (?,?,?,?,?,?)',
          [id, message.guildId, message.channelId, message.author.id, baseTitle || att.name?.slice(0, 200) || null, kind]
        );
        posted.push({ id, kind, name: att.name || (kind === 'video' ? 'video' : 'track') });
      } catch (e) {
        logger.error('[Showcase] processing failed', { error: e.message, file: att.name });
        await fsp.rm(path.join(SHOWCASE_DIR, id), { recursive: true, force: true }).catch(() => {});
      } finally {
        await fsp.unlink(tmpFile).catch(() => {});
      }
    }

    // Remove the original (kills the Discord CDN download link). Do this even if some
    // items failed — we don't want the raw attachment lingering in a showcase channel.
    await message.delete().catch(() => {});

    if (!posted.length) {
      await message.channel.send({ content: `<@${message.author.id}> I couldn't process that upload — make sure it's a normal audio/video file under 250 MB.` }).catch(() => {});
      return true;
    }

    const base = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');
    for (const item of posted) {
      const url = `${base}/showcase/${item.id}`;
      const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: `${creatorName} shared a ${item.kind === 'video' ? 'video' : 'track'}`, iconURL: message.author.displayAvatarURL() })
        .setTitle(baseTitle || item.name)
        .setDescription(`▶️ **[Play it here](${url})** — streamed, watermarked, no download.`)
        .setFooter({ text: 'Creator content • protected playback' })
        .setTimestamp();
      await message.channel.send({ content: `🎶 New from <@${message.author.id}>`, embeds: [embed] }).catch(() => {});
    }
    return true;
  } catch (err) {
    logger.error('[Showcase] hook error', { error: err.message });
    return false;
  }
}

// ── admin helpers (used by the /showcase command) ───────────────────────────
export async function addShowcaseChannel(guildId, channelId, addedBy) {
  await pool.execute(
    'INSERT INTO showcase_channels (channel_id, guild_id, enabled, added_by) VALUES (?,?,1,?) ON DUPLICATE KEY UPDATE enabled = 1',
    [channelId, guildId, addedBy || null]
  );
  invalidateShowcaseCache();
}
export async function removeShowcaseChannel(channelId) {
  await pool.execute('DELETE FROM showcase_channels WHERE channel_id = ?', [channelId]);
  invalidateShowcaseCache();
}
export async function listShowcaseChannels(guildId) {
  const [rows] = await pool.execute('SELECT channel_id FROM showcase_channels WHERE guild_id = ? AND enabled = 1', [guildId]);
  return rows.map(r => r.channel_id);
}
