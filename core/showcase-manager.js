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

export async function isShowcaseChannel(channelId) {
  return (await showcaseChannels()).has(channelId);
}

function showcaseUrl(id) {
  const base = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');
  return `${base}/showcase/${id}`;
}

export function buildShowcaseEmbed({ user, creatorName, title, kind, id }) {
  return new EmbedBuilder()
    .setColor(0xF0A500)
    .setAuthor({ name: `${creatorName} shared a ${kind === 'video' ? 'video' : 'track'}`, iconURL: user?.displayAvatarURL?.() || undefined })
    .setTitle(title || (kind === 'video' ? 'New video' : 'New track'))
    .setDescription(`▶️ **[Play it here](${showcaseUrl(id)})** — streamed, watermarked, no download.`)
    .setFooter({ text: 'Creator content • protected playback' })
    .setTimestamp();
}

/**
 * Core ingest: download → transcode to AES-HLS → DB row. Returns {id, kind} or throws.
 * Shared by the channel-drop hook and the /showcase upload command.
 */
async function ingest({ url, inputPath, name, size, kind, guildId, channelId, creatorId, creatorName, title }) {
  if (size && size > MAX_BYTES) throw new Error('file too large');
  const id = crypto.randomBytes(8).toString('hex');
  let src = inputPath, tmpFile = null;
  if (!src) {
    const tmpBase = path.join(SHOWCASE_DIR, '_tmp');
    await fsp.mkdir(tmpBase, { recursive: true });
    tmpFile = path.join(tmpBase, `${id}-${(name || 'media').replace(/[^\w.-]/g, '_')}`);
    await downloadTo(url, tmpFile);
    src = tmpFile;
  }
  try {
    await transcodeToHls(src, path.join(SHOWCASE_DIR, id), kind, creatorName);
    await pool.execute(
      'INSERT INTO showcase_items (id, guild_id, channel_id, creator_id, title, kind) VALUES (?,?,?,?,?,?)',
      [id, guildId, channelId, creatorId, (title || name)?.slice(0, 200) || null, kind]
    );
    return { id, kind };
  } catch (e) {
    await fsp.rm(path.join(SHOWCASE_DIR, id), { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    if (tmpFile) await fsp.unlink(tmpFile).catch(() => {});
  }
}

// classify by filename/mime — exported for the web upload route
export function classifyMedia(name, contentType) {
  return classify({ name, contentType });
}

// ── upload tokens (button → ephemeral web-upload link) ──────────────────────
export function signUploadToken(guildId, channelId, userId, ttlMs = 20 * 60 * 1000) {
  const exp = Date.now() + ttlMs;
  const data = `${guildId}.${channelId}.${userId}.${exp}`;
  const mac = crypto.createHmac('sha256', SECRET).update(`up:${data}`).digest('base64url');
  return `${data}.${mac}`;
}
export function verifyUploadToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 5) return null;
  const [guildId, channelId, userId, exp, mac] = parts;
  if (Number(exp) < Date.now()) return null;
  const good = crypto.createHmac('sha256', SECRET).update(`up:${guildId}.${channelId}.${userId}.${exp}`).digest('base64url');
  try { if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null; } catch { return null; }
  return { guildId, channelId, userId };
}

/**
 * Web-upload path: a local file (multer) → protected stream → post the embed via the
 * right guild client. The file never touched Discord. Returns { id, kind }.
 */
export async function ingestWebUpload({ inputPath, name, size, guildId, channelId, creatorId, title }) {
  const kind = classify({ name });
  if (!kind) throw new Error('not audio/video');
  const client = global.botManager?.getClientForGuild?.(guildId) || global.client || global.botManager?.getDefaultClient?.();
  if (!client) throw new Error('no client');
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const member = guild ? await guild.members.fetch(creatorId).catch(() => null) : null;
  const user = await client.users.fetch(creatorId).catch(() => null);
  const creatorName = member?.displayName || user?.username || 'creator';

  const { id } = await ingest({ inputPath, name, size, kind, guildId, channelId, creatorId, creatorName, title });

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased?.()) {
    await channel.send({
      content: `🎶 New from <@${creatorId}>`,
      embeds: [buildShowcaseEmbed({ user, creatorName, title: title || name, kind, id })],
    }).catch(() => {});
  }
  return { id, kind };
}

/**
 * messageCreate hook (channel-drop path). Returns true if it consumed a showcase upload.
 * Convenient but the raw file briefly exists on Discord's CDN before deletion — the
 * /showcase upload command avoids that.
 */
export async function handleShowcaseMessage(message) {
  try {
    if (!message.guild || message.author?.bot) return false;
    if (!message.attachments?.size) return false;
    if (!(await showcaseChannels()).has(message.channelId)) return false;

    const media = [...message.attachments.values()]
      .map(a => ({ att: a, kind: classify(a) }))
      .filter(x => x.kind);
    if (!media.length) return false; // not media — leave it for normal handling

    const creatorName = message.member?.displayName || message.author.username;
    const baseTitle = (message.content || '').trim().slice(0, 200);
    const posted = [];
    for (const { att, kind } of media) {
      try {
        const r = await ingest({
          url: att.url, name: att.name, size: att.size, kind,
          guildId: message.guildId, channelId: message.channelId,
          creatorId: message.author.id, creatorName, title: baseTitle,
        });
        posted.push({ ...r, name: att.name });
      } catch (e) {
        logger.error('[Showcase] channel-drop processing failed', { error: e.message, file: att.name });
      }
    }

    // Remove the original (kills the Discord CDN link), even on partial failure.
    await message.delete().catch(() => {});

    if (!posted.length) {
      await message.channel.send({ content: `<@${message.author.id}> I couldn't process that upload — make sure it's a normal audio/video file under 250 MB.` }).catch(() => {});
      return true;
    }
    for (const item of posted) {
      await message.channel.send({
        content: `🎶 New from <@${message.author.id}>`,
        embeds: [buildShowcaseEmbed({ user: message.author, creatorName, title: baseTitle || item.name, kind: item.kind, id: item.id })],
      }).catch(() => {});
    }
    return true;
  } catch (err) {
    logger.error('[Showcase] hook error', { error: err.message });
    return false;
  }
}

/**
 * /showcase upload — the PRIVATE path. The attached file goes only to the bot (never
 * posted to the channel), so no other member can grab it. Ephemeral throughout.
 */
export async function handleShowcaseUploadCommand(interaction) {
  if (!(await isShowcaseChannel(interaction.channelId))) {
    return interaction.reply({ content: 'Run this **in a Creator Showcase channel** — your upload will be posted there as a protected stream.', ephemeral: true });
  }
  const att = interaction.options.getAttachment('file');
  const kind = att && classify(att);
  if (!kind) {
    return interaction.reply({ content: 'Attach an **audio or video** file (mp3, wav, mp4, mov, webm, …).', ephemeral: true });
  }
  await interaction.reply({ content: '⏳ Processing your upload privately — this can take a moment for video…', ephemeral: true });
  try {
    const creatorName = interaction.member?.displayName || interaction.user.username;
    const title = (interaction.options.getString('title') || '').slice(0, 200);
    const { id } = await ingest({
      url: att.url, name: att.name, size: att.size, kind,
      guildId: interaction.guildId, channelId: interaction.channelId,
      creatorId: interaction.user.id, creatorName, title,
    });
    await interaction.channel.send({
      content: `🎶 New from <@${interaction.user.id}>`,
      embeds: [buildShowcaseEmbed({ user: interaction.user, creatorName, title: title || att.name, kind, id })],
    });
    await interaction.editReply('✅ Posted! Your raw file was **never shared in the channel** — only the protected, no-download stream is visible.');
  } catch (e) {
    logger.error('[Showcase] command upload failed', { error: e.message });
    await interaction.editReply('❌ Couldn\'t process that — make sure it\'s a normal audio/video file under 250 MB.');
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
