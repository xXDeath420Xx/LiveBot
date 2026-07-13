// On-demand soundboard. Reuses the per-guild sound library in `vc_sound_files`
// + sounds/<guildId>/ (the same store the random VC-drop system uses), and the
// proven discord-player playback path. Multi-bot correct: it plays through
// `client.player` using the channel's guild voice adapter, so whichever bot
// received the interaction (main OR custom) joins and plays.
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
// discord-player re-exports @discordjs/voice — same instance the player uses, so
// subscribing our clip player to the live connection is safe (no dual-connection).
import { createAudioPlayer, createAudioResource } from 'discord-player';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOUNDS_DIR = path.join(__dirname, '..', 'sounds');
export const ALLOWED_EXT = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.webm'];
export const MAX_BYTES = 10 * 1024 * 1024; // 10MB — well past Discord's tiny soundboard cap

export function sanitizeName(raw) {
  return String(raw || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 100);
}
export function guildSoundsDir(guildId) {
  return path.join(SOUNDS_DIR, guildId);
}

export async function listSounds(guildId) {
  const [rows] = await pool.execute(
    'SELECT id, name, emoji, file_path, play_count FROM vc_sound_files WHERE guild_id = ? AND (enabled = 1 OR enabled IS NULL) ORDER BY name ASC',
    [guildId]
  );
  return rows;
}

export async function getSoundById(id) {
  const [rows] = await pool.execute('SELECT * FROM vc_sound_files WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function getSoundByName(guildId, name) {
  const [rows] = await pool.execute('SELECT * FROM vc_sound_files WHERE guild_id = ? AND name = ?', [guildId, sanitizeName(name)]);
  return rows[0] || null;
}

// Download a Discord attachment to sounds/<guildId>/<name>.<ext> and upsert the
// row. Returns { ok, sound? , reason? }.
export async function saveFromAttachment(guildId, name, attachment, addedBy, emoji = null) {
  const clean = sanitizeName(name);
  if (!clean) return { ok: false, reason: 'Give the sound a name (letters, numbers, _ or -).' };
  const ext = path.extname(attachment.name || '').toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return { ok: false, reason: `Unsupported file type. Allowed: ${ALLOWED_EXT.join(', ')}` };
  if (attachment.size > MAX_BYTES) return { ok: false, reason: `File too large (${(attachment.size / 1024 / 1024).toFixed(1)}MB). Max ${MAX_BYTES / 1024 / 1024}MB.` };

  const dir = guildSoundsDir(guildId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${clean}${ext}`);
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) return { ok: false, reason: `Couldn't download the file (HTTP ${res.status}).` };
    const buf = Buffer.from(await res.arrayBuffer());
    // remove any prior file for this name with a different extension
    for (const e of ALLOWED_EXT) { const p = path.join(dir, `${clean}${e}`); if (p !== filePath && fs.existsSync(p)) fs.unlinkSync(p); }
    fs.writeFileSync(filePath, buf);
  } catch (e) {
    logger.error(`[Soundboard] download/save failed for ${clean} in ${guildId}: ${e.message}`);
    return { ok: false, reason: 'Failed to save the file.' };
  }

  await pool.execute(
    `INSERT INTO vc_sound_files (guild_id, name, emoji, file_path, added_by, play_count, enabled)
     VALUES (?, ?, ?, ?, ?, 0, 1)
     ON DUPLICATE KEY UPDATE emoji = VALUES(emoji), file_path = VALUES(file_path), added_by = VALUES(added_by), enabled = 1`,
    [guildId, clean, emoji, filePath, addedBy]
  ).catch(async (e) => {
    // table may lack a unique key on (guild_id,name); fall back to manual upsert
    if (e.code === 'ER_DUP_ENTRY' || true) {
      const existing = await getSoundByName(guildId, clean);
      if (existing) {
        await pool.execute('UPDATE vc_sound_files SET emoji = ?, file_path = ?, added_by = ?, enabled = 1 WHERE id = ?',
          [emoji, filePath, addedBy, existing.id]).catch(() => {});
      } else {
        await pool.execute('INSERT INTO vc_sound_files (guild_id, name, emoji, file_path, added_by, play_count, enabled) VALUES (?,?,?,?,?,0,1)',
          [guildId, clean, emoji, filePath, addedBy]).catch(() => {});
      }
    }
  });

  const sound = await getSoundByName(guildId, clean);
  return { ok: true, sound };
}

// Save a raw uploaded buffer (dashboard drag-and-drop) to disk + DB. Mirrors
// saveFromAttachment but takes a Buffer + original filename instead of a URL.
export async function saveFromBuffer(guildId, name, buffer, originalName, addedBy, emoji = null) {
  const clean = sanitizeName(name);
  if (!clean) return { ok: false, reason: 'Give the sound a name (letters, numbers, _ or -).' };
  const ext = path.extname(originalName || '').toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return { ok: false, reason: `Unsupported file type. Allowed: ${ALLOWED_EXT.join(', ')}` };
  if (!buffer?.length) return { ok: false, reason: 'Empty file.' };
  if (buffer.length > MAX_BYTES) return { ok: false, reason: `File too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Max ${MAX_BYTES / 1024 / 1024}MB.` };

  const dir = guildSoundsDir(guildId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${clean}${ext}`);
  try {
    for (const e of ALLOWED_EXT) { const p = path.join(dir, `${clean}${e}`); if (p !== filePath && fs.existsSync(p)) fs.unlinkSync(p); }
    fs.writeFileSync(filePath, buffer);
  } catch (e) {
    logger.error(`[Soundboard] buffer save failed for ${clean} in ${guildId}: ${e.message}`);
    return { ok: false, reason: 'Failed to save the file.' };
  }

  const existing = await getSoundByName(guildId, clean);
  if (existing) {
    await pool.execute('UPDATE vc_sound_files SET emoji = ?, file_path = ?, added_by = ?, enabled = 1 WHERE id = ?',
      [emoji, filePath, addedBy, existing.id]).catch(() => {});
  } else {
    await pool.execute('INSERT INTO vc_sound_files (guild_id, name, emoji, file_path, added_by, play_count, enabled) VALUES (?,?,?,?,?,0,1)',
      [guildId, clean, emoji, filePath, addedBy]).catch(() => {});
  }
  const sound = await getSoundByName(guildId, clean);
  return { ok: true, sound };
}

export async function deleteSound(guildId, name) {
  const sound = await getSoundByName(guildId, name);
  if (!sound) return { ok: false, reason: 'No sound by that name.' };
  try { if (sound.file_path && fs.existsSync(sound.file_path)) fs.unlinkSync(sound.file_path); } catch { /* ignore */ }
  await pool.execute('DELETE FROM vc_sound_files WHERE id = ?', [sound.id]);
  return { ok: true, sound };
}

export async function deleteSoundById(guildId, id) {
  const [rows] = await pool.execute('SELECT * FROM vc_sound_files WHERE id = ? AND guild_id = ?', [id, guildId]);
  const sound = rows[0];
  if (!sound) return { ok: false, reason: 'No such sound.' };
  try { if (sound.file_path && fs.existsSync(sound.file_path)) fs.unlinkSync(sound.file_path); } catch { /* ignore */ }
  await pool.execute('DELETE FROM vc_sound_files WHERE id = ?', [sound.id]);
  return { ok: true, sound };
}

function incrementPlayCount(id) {
  pool.execute('UPDATE vc_sound_files SET play_count = play_count + 1 WHERE id = ?', [id]).catch(() => {});
}

/**
 * Play a sound into a voice channel through the given client's player.
 * `client` MUST be the bot that received the interaction (so custom bots play
 * as themselves).
 *
 * If MUSIC is already playing in the SAME channel, it DUCKS: pause the song,
 * play the clip on the live connection, then resume the song at its exact
 * position. Otherwise it does a normal join-play-leave via discord-player.
 * Returns { ducked: boolean }.
 */
export async function playSound(client, voiceChannel, sound, { volume = 0.65 } = {}) {
  const player = client?.player;
  if (!player) throw new Error('The audio player isn\'t ready yet — try again in a moment.');
  if (!sound?.file_path || !fs.existsSync(sound.file_path)) throw new Error('That sound\'s file is missing on disk.');

  const guildId = voiceChannel.guild.id;
  const queue = player.nodes?.get(guildId);
  const musicPlaying = !!(queue && queue.isPlaying && queue.isPlaying()
    && queue.dispatcher?.voiceConnection && queue.dispatcher?.audioPlayer);

  if (musicPlaying) {
    if (queue.channel?.id !== voiceChannel.id) {
      throw new Error('I\'m playing music in another voice channel right now — join that one or `/stop` the music first.');
    }
    await duckAndPlay(queue, sound, volume);
    incrementPlayCount(sound.id);
    return { ducked: true };
  }

  await player.play(voiceChannel, sound.file_path, {
    nodeOptions: {
      metadata: { soundboard: true, channelId: voiceChannel.id, guildId },
      leaveOnEnd: true,
      leaveOnEndCooldown: 1500,
      leaveOnEmpty: true,
      leaveOnEmptyCooldown: 0,
      volume: Math.max(1, Math.min(150, Math.round(volume * 100))),
      selfDeaf: true,
    },
  });
  incrementPlayCount(sound.id);
  return { ducked: false };
}

// Pause the queue's music, play the clip on the SAME voice connection via a
// temporary audio player, then restore the music player's subscription and
// resume from where it left off. Never disconnects.
async function duckAndPlay(queue, sound, volume) {
  const conn = queue.dispatcher.voiceConnection;
  const musicPlayer = queue.dispatcher.audioPlayer;
  const wasPaused = queue.node.isPaused();

  queue.node.setPaused(true); // hold the song at its current position

  const clipPlayer = createAudioPlayer();
  const resource = createAudioResource(fs.createReadStream(sound.file_path), { inlineVolume: true });
  try { resource.volume?.setVolume(Math.max(0.05, Math.min(2, volume))); } catch { /* no inline volume */ }

  let subscription = null;
  try {
    subscription = conn.subscribe(clipPlayer); // replaces the music player's subscription
    clipPlayer.play(resource);

    await new Promise((resolve) => {
      let started = false;
      const finish = () => resolve();
      clipPlayer.on('stateChange', (_old, ns) => {
        if (ns.status === 'playing' || ns.status === 'buffering') started = true;
        if (ns.status === 'idle' && started) finish();
      });
      clipPlayer.on('error', (e) => { logger.warn(`[Soundboard] duck clip error: ${e.message}`); finish(); });
      setTimeout(finish, 30000); // safety cap so we always restore music
    });
  } finally {
    try { clipPlayer.stop(true); } catch { /* ignore */ }
    try { subscription?.unsubscribe(); } catch { /* ignore */ }
    // Re-attach the music player to the connection and resume (unless the user
    // had paused it before we started).
    try { conn.subscribe(musicPlayer); } catch (e) { logger.error(`[Soundboard] failed to restore music: ${e.message}`); }
    if (!wasPaused) { try { queue.node.setPaused(false); } catch { /* ignore */ } }
  }
  return true;
}

/** Stop soundboard playback in a guild and leave (no-op if nothing playing). */
export async function stopGuild(client, guildId) {
  const queue = client?.player?.nodes?.get(guildId);
  if (!queue) return false;
  try { queue.delete(); return true; } catch { return false; }
}

/** Is this guild currently playing something (music or a sound)? */
export function isBusy(client, guildId) {
  const queue = client?.player?.nodes?.get(guildId);
  return !!(queue && queue.isPlaying && queue.isPlaying());
}
