import { EmbedBuilder } from 'discord.js';
import crypto from 'crypto';
import { normalizeAltText } from '../utils/accessible-attachment.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { toPlain } from '../utils/channel-name-style.js';
import { getStreamSchedule, getTwitchUser } from '../utils/platforms/twitch-api.js';
import {
  getGuildTimezone,
  formatTimeInZone,
  getZoneAbbreviation,
  getLocalDateParts
} from '../utils/guild-timezone.js';
import { logFeatureEvent } from './feature-log.js';
import { discardReplacedUpload } from './server-image-uploads.js';
import { servedByAnotherClient } from './guild-presence-logic.js';
import {
  loadCustomDays, hashCustomDays, mergeSegments, localDayKey, posterMonth,
  buildMonth, firstWeekday, monthName,
} from './schedule-calendar.js';

const CHANGE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes — wait for streamer to finish editing

// A schedule whose channel is unreachable for a reason that may pass (missing permission, network)
// keeps retrying; its warning is logged at most once per 6 hours per sync instead of every tick.
const MISSING_CHANNEL_WARN_MS = 6 * 60 * 60 * 1000;
const missingChannelWarnedAt = new Map(); // sync id -> ms

/**
 * Why a schedule sync is paused (twitch_schedule_sync_config.paused_reason, migration 434):
 *   channel_deleted  its channel is gone; the server picks a new one on the Twitch Schedules page
 *   guild_left       no bot of ours is in the server any more; resumes by itself if one comes back
 * Paused syncs also have is_enabled = 0, so nothing else needs to know about the column.
 */
export const SCHEDULE_PAUSE_REASONS = Object.freeze({
  channel_deleted: 'Paused: channel deleted',
  guild_left: 'Paused: the bot is no longer in this server',
});

/** Guild for a sync's server-log posts: the channel's own, else whichever bot serves the server. */
function scheduleLogGuild(client, syncConfig, channel = null) {
  return channel?.guild
    || client?.guilds?.cache?.get(syncConfig.guild_id)
    || global.botManager?.getClientForGuild?.(syncConfig.guild_id)?.guilds.cache.get(syncConfig.guild_id);
}

/** A broken sync retries every tick, so its failure is posted at most once a day per sync. */
function logScheduleFailed(client, syncConfig, why, channel = null) {
  void logFeatureEvent(() => (scheduleLogGuild(client, syncConfig, channel)), 'twitch-schedule.failed', () => ({
    title: '⚠️ Schedule Sync Failed',
    description: `The Twitch schedule for **${syncConfig.username}** could not be posted. It keeps retrying; this is reported at most once a day.`,
    fields: [
      ['Streamer', syncConfig.username],
      ['Channel', syncConfig.discord_channel_id ? `<#${syncConfig.discord_channel_id}>` : null],
      ['Why', String(why || 'Unknown error').slice(0, 300), false],
    ],
    throttle: { key: 'tsched-fail:' + syncConfig.id, ms: 86400000 },
  }));
}

// Canvas is optional. If not installed, image generation is skipped and we fall back
// to the text embed.
let Canvas = null;
try { Canvas = await import('canvas'); } catch { /* silent; image gen disabled */ }

// Stable warm palette — categories hash here so the same game always lands on the
// same colour across renders. Shared by the monthly and weekly views.
const PALETTE = ['#F9C9D0', '#FDE5A3', '#C8E6B5', '#FBCBA4', '#D8CCE8', '#BEDCED', '#F2BFAE', '#E8DBB5'];
const strToColor = (s) => {
  if (!s) return '#EEE1C5';
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

/**
 * Manages Twitch schedule syncing to Discord
 */
export default class TwitchScheduleManager {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get all enabled schedule syncs for this bot's guilds
   * @returns {Promise<Array>}
   */
  async getEnabledSyncs() {
    try {
      let query = `
        SELECT
          tss.id,
          tss.guild_id,
          tss.streamer_id,
          tss.discord_channel_id,
          tss.mention_role_id,
          tss.custom_message,
          tss.last_synced,
          tss.schedule_hash,
          tss.last_message_id,
          tss.change_detected_at,
          tss.sync_interval_minutes,
          tss.weekly_refresh,
          tss.last_weekly_refresh,
          tss.view_mode,
          tss.force_refresh,
          tss.layout,
          tss.background_mode,
          tss.background_url,
          tss.background_prompt,
          tss.background_cache_url,
          tss.accent_color,
          tss.card_title,
          tss.card_footer,
          tss.schedule_source,
          tss.side_art_url,
          tss.card_disclaimer,
          s.platform_user_id,
          s.username,
          s.profile_image_url
        FROM twitch_schedule_sync_config tss
        JOIN streamers s ON tss.streamer_id = s.streamer_id
        WHERE tss.is_enabled = 1 AND s.platform = 'twitch'
      `;

      const params = [];

      // Filter by this bot's assigned guilds
      if (!this.client.isDefaultBot && this.client.assignedGuilds) {
        query += ` AND tss.guild_id IN (${this.client.assignedGuilds.map(() => '?').join(',')})`;
        params.push(...this.client.assignedGuilds);
      } else if (this.client.isDefaultBot) {
        // Default bot should only process guilds without custom bots
        const [customGuilds] = await pool.execute('SELECT DISTINCT guild_id FROM guild_bot_mapping');
        if (customGuilds.length > 0) {
          const customGuildIds = customGuilds.map(r => r.guild_id);
          query += ` AND tss.guild_id NOT IN (${customGuildIds.map(() => '?').join(',')})`;
          params.push(...customGuildIds);
        }
      }

      const [syncs] = await pool.execute(query, params);
      return syncs;
    } catch (error) {
      logger.error('[TwitchScheduleManager] Error getting enabled syncs:', {
        error: error.message,
        botId: this.client.botId || 'default'
      });
      return [];
    }
  }

  /**
   * Get the Twitch user ID for a streamer
   * @param {Object} syncConfig - The sync configuration
   * @returns {Promise<string|null>}
   */
  async getTwitchUserId(syncConfig) {
    // If platform_user_id is temporary, fetch the real one
    if (syncConfig.platform_user_id && syncConfig.platform_user_id.startsWith('temp_')) {
      try {
        const userData = await getTwitchUser(syncConfig.username);
        if (userData && userData.id) {
          // Update the database with the real user ID
          await pool.execute(
            'UPDATE streamers SET platform_user_id = ? WHERE streamer_id = ?',
            [userData.id, syncConfig.streamer_id]
          );
          return userData.id;
        }
      } catch (error) {
        logger.warn(`[TwitchScheduleManager] Failed to fetch Twitch user ID for ${syncConfig.username}:`, error.message);
      }
    }

    // Return existing user ID if not temporary
    if (syncConfig.platform_user_id && !syncConfig.platform_user_id.startsWith('temp_')) {
      return syncConfig.platform_user_id;
    }

    return null;
  }

  /**
   * Hash schedule segments to detect changes
   */
  hashSchedule(segments) {
    const data = segments.map(s => `${s.start_time}|${s.end_time}|${s.title}|${s.category?.id}`).join('\n');
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  /**
   * Sync a single schedule configuration
   * Only posts/edits when the schedule actually changes.
   * Waits 10 minutes after detecting a change before posting (so streamers can finish editing).
   */
  async syncSchedule(syncConfig, { skipCooldown = false } = {}) {
    try {
      const source = syncConfig.schedule_source || 'twitch';
      const customDays = source === 'twitch' ? new Map() : await loadCustomDays(syncConfig.id);
      syncConfig._customDays = customDays;
      const tz = source === 'twitch' && syncConfig.layout !== 'calendar' ? null : await getGuildTimezone(syncConfig.guild_id);

      let twitchSegments = [];
      if (source !== 'custom') {
        const twitchUserId = await this.getTwitchUserId(syncConfig);

        if (!twitchUserId && !customDays.size) {
          logger.warn(`[TwitchScheduleManager] No valid Twitch user ID for streamer ${syncConfig.username}`);
          if (syncConfig.force_refresh) {
            await pool.execute('UPDATE twitch_schedule_sync_config SET force_refresh = 0 WHERE id = ?', [syncConfig.id]);
          }
          logScheduleFailed(this.client, syncConfig, `Could not find the Twitch account **${syncConfig.username}** (renamed or deleted?)`);
          return;
        }

        // Fetch schedule from Twitch API
        const scheduleResponse = twitchUserId ? await getStreamSchedule(twitchUserId) : null;
        twitchSegments = scheduleResponse?.data?.data?.segments || [];
      }

      const scheduleData = { segments: source === 'twitch' ? twitchSegments : mergeSegments(source, twitchSegments, customDays, tz) };

      if (scheduleData.segments.length === 0 && !customDays.size) {
        logger.debug(`[TwitchScheduleManager] No scheduled streams for ${syncConfig.username}`);
        if (syncConfig.force_refresh) {
          await pool.execute('UPDATE twitch_schedule_sync_config SET force_refresh = 0 WHERE id = ?', [syncConfig.id]);
        }
        return;
      }

      // Hash the schedule to detect changes. A filled-in day off has no segment, and a month poster
      // has to move on when the month does, so both go into the hash.
      const parts = [this.hashSchedule(scheduleData.segments)];
      if (customDays.size) parts.push(hashCustomDays(customDays));
      if (syncConfig.layout === 'calendar') { const m = posterMonth(tz); parts.push(`${m.year}-${m.month}`); }
      const newHash = parts.length === 1 ? parts[0]
        : crypto.createHash('sha256').update(parts.join('|')).digest('hex').substring(0, 16);
      const oldHash = syncConfig.schedule_hash;

      // Weekly refresh — if enabled and 7+ days have passed, always proceed even if hash is unchanged
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      const weeklyDue = !!syncConfig.weekly_refresh && (
        !syncConfig.last_weekly_refresh ||
        (Date.now() - new Date(syncConfig.last_weekly_refresh).getTime()) >= WEEK_MS
      );

      // Skip only if hash matches, message exists, no change is pending, and no weekly refresh due.
      // skipCooldown=true (dashboard force-sync, force_refresh flag) overrides this — a re-render
      // is wanted even when Twitch's data is identical to what's already posted.
      if (!skipCooldown && newHash === oldHash && syncConfig.last_message_id && !syncConfig.change_detected_at && !weeklyDue) {
        logger.debug(`[TwitchScheduleManager] Schedule unchanged for ${syncConfig.username}`);
        // Every other early return clears this; without it here a force_refresh
        // set while the schedule happens to be unchanged would stay pending for
        // good, making the row permanently "due" on every single tick.
        if (syncConfig.force_refresh) {
          await pool.execute('UPDATE twitch_schedule_sync_config SET force_refresh = 0 WHERE id = ?', [syncConfig.id]);
        }
        return;
      }

      // Cooldown handling
      if (!skipCooldown) {
        if (syncConfig.change_detected_at) {
          // A change was previously detected — we're in the cooldown window
          if (newHash !== oldHash) {
            // Schedule changed AGAIN during cooldown — reset the timer with the new hash
            await pool.execute(
              'UPDATE twitch_schedule_sync_config SET change_detected_at = NOW(), schedule_hash = ? WHERE id = ?',
              [newHash, syncConfig.id]
            );
            logger.info(`[TwitchScheduleManager] Schedule changed again for ${syncConfig.username} — resetting 10 min timer`);
            return;
          }
          // Hash stable since detection — check if cooldown elapsed
          const elapsed = Date.now() - new Date(syncConfig.change_detected_at).getTime();
          if (elapsed < CHANGE_COOLDOWN_MS) {
            logger.debug(`[TwitchScheduleManager] Schedule for ${syncConfig.username} still in cooldown (${Math.floor(elapsed / 1000)}s elapsed)`);
            return;
          }
          // Cooldown elapsed — fall through to post
          logger.info(`[TwitchScheduleManager] Cooldown elapsed for ${syncConfig.username} — posting now`);
        } else if (newHash !== oldHash) {
          // First detection of a change (or first-ever sync where oldHash is NULL)
          await pool.execute(
            'UPDATE twitch_schedule_sync_config SET change_detected_at = NOW(), schedule_hash = ? WHERE id = ?',
            [newHash, syncConfig.id]
          );
          logger.info(`[TwitchScheduleManager] Schedule change detected for ${syncConfig.username} — waiting 10 min before posting`);
          return;
        }
      }

      // Ready to post/edit — cooldown passed or first-time post
      let channelError = null;
      const channel = await this.client.channels.fetch(syncConfig.discord_channel_id).catch(err => { channelError = err; return null; });
      if (!channel) {
        await this.handleMissingChannel(syncConfig, channelError);
        return;
      }

      // Diff-based cancellation detection: segments that were present in the previous
      // sync but are now absent from the Twitch API response — and whose start time
      // hasn't passed yet — count as canceled.
      let previousSegments = [];
      try { previousSegments = syncConfig.previous_segments_json ? JSON.parse(syncConfig.previous_segments_json) : []; } catch {}
      const nowMs = Date.now();
      const currentIds = new Set(scheduleData.segments.map(s => s.id));
      const canceledSegments = source === 'custom' ? [] : previousSegments
        .filter(p => p?.id && !currentIds.has(p.id) && p.start_time && new Date(p.start_time).getTime() > nowMs)
        .filter(p => !String(p.id).startsWith('custom:') && !(tz && customDays.has(localDayKey(p.start_time, tz))));

      const embed = await this.buildScheduleEmbed(syncConfig, scheduleData);
      const drawn = {};
      const scheduleImage = await this.buildScheduleImage(syncConfig, scheduleData, canceledSegments, drawn).catch(err => {
        logger.warn(`[TwitchScheduleManager] image render failed for ${syncConfig.username}: ${err.message}`);
        return null;
      });
      const webUrl = `https://certifriedmultitool.com/schedule/${encodeURIComponent(syncConfig.username)}`;
      let messageContent = syncConfig.custom_message || `📅 **${syncConfig.username}**'s ꜱᴛʀᴇᴀᴍɪɴɢ ꜱᴄʜᴇᴅᴜʟᴇ\n${webUrl}`;
      if (syncConfig.mention_role_id) {
        // If mention_role_id equals guild_id, it's the @everyone role — use plain text
        if (syncConfig.mention_role_id === syncConfig.guild_id) {
          messageContent = `@everyone ${messageContent}`;
        } else {
          messageContent = `<@&${syncConfig.mention_role_id}> ${messageContent}`;
        }
      }

      let messageId = syncConfig.last_message_id;

      // Weekly refresh already computed above as `weeklyDue`.
      // When due AND we have a prior message, delete it and force a fresh send below.
      if (weeklyDue && messageId) {
        try {
          const oldMsg = await channel.messages.fetch(messageId).catch(() => null);
          if (oldMsg) {
            await oldMsg.delete().catch(err => {
              logger.warn(`[TwitchScheduleManager] Weekly refresh: failed to delete old message ${messageId} for ${syncConfig.username}: ${err.message}`);
            });
            logger.info(`[TwitchScheduleManager] Weekly refresh: deleted old schedule message for ${syncConfig.username} in guild ${syncConfig.guild_id}`);
          }
        } catch (err) {
          logger.warn(`[TwitchScheduleManager] Weekly refresh cleanup error for ${syncConfig.username}: ${err.message}`);
        }
        messageId = null; // force a fresh send
      }

      this._lastUser = syncConfig.username;
      const written = await this.writeScheduleMessage({
        channelId: channel.id,
        messageId,
        content: messageContent,
        embed,
        image: scheduleImage,
        filename: `${syncConfig.username}-schedule.png`,
        /* The card's own description of itself when it drew one — the API
           response describes far more streams than any card shows. */
        altText: normalizeAltText(drawn.alt
          || describeTwitchSchedule(syncConfig.username, scheduleData.segments, canceledSegments)),
      });
      if (!written) {
        logger.error(`[TwitchScheduleManager] Could not write the schedule for ${syncConfig.username} in guild ${syncConfig.guild_id}`);
        if (syncConfig.force_refresh) {
          await pool.execute('UPDATE twitch_schedule_sync_config SET force_refresh = 0 WHERE id = ?', [syncConfig.id]);
        }
        logScheduleFailed(this.client, syncConfig, 'Discord refused the schedule message — check the bot can send messages and attach files in that channel', channel);
        return;
      }
      messageId = written;

      // Snapshot current segments so the next sync can diff for cancellations.
      const segmentsSnapshot = JSON.stringify(scheduleData.segments.map(s => ({
        id: s.id, title: s.title, start_time: s.start_time, end_time: s.end_time,
        category: s.category ? { id: s.category.id, name: s.category.name } : null,
      })));

      // Update DB: hash, message ID, timestamps, clear change timer, snapshot segments.
      // When weekly refresh fired, also update last_weekly_refresh.
      if (weeklyDue) {
        await pool.execute(
          'UPDATE twitch_schedule_sync_config SET schedule_hash = ?, last_message_id = ?, last_synced = NOW(), last_weekly_refresh = NOW(), change_detected_at = NULL, previous_segments_json = ?, force_refresh = 0 WHERE id = ?',
          [newHash, messageId, segmentsSnapshot, syncConfig.id]
        ).catch(async (e) => {
          if (!/Unknown column/i.test(e.message)) throw e;
          await pool.execute('UPDATE twitch_schedule_sync_config SET schedule_hash = ?, last_message_id = ?, last_synced = NOW(), last_weekly_refresh = NOW(), change_detected_at = NULL, force_refresh = 0 WHERE id = ?', [newHash, messageId, syncConfig.id]);
        });
      } else {
        await pool.execute(
          'UPDATE twitch_schedule_sync_config SET schedule_hash = ?, last_message_id = ?, last_synced = NOW(), change_detected_at = NULL, previous_segments_json = ?, force_refresh = 0 WHERE id = ?',
          [newHash, messageId, segmentsSnapshot, syncConfig.id]
        ).catch(async (e) => {
          if (!/Unknown column/i.test(e.message)) throw e;
          await pool.execute('UPDATE twitch_schedule_sync_config SET schedule_hash = ?, last_message_id = ?, last_synced = NOW(), change_detected_at = NULL, force_refresh = 0 WHERE id = ?', [newHash, messageId, syncConfig.id]);
        });
      }

      // The old message was deleted for the weekly repost; an edit keeps its id; anything else is a fresh post.
      const previousId = syncConfig.last_message_id;
      const messageUrl = `https://discord.com/channels/${syncConfig.guild_id}/${channel.id}/${messageId}`;
      void logFeatureEvent(() => (scheduleLogGuild(this.client, syncConfig, channel)),
        () => (weeklyDue && previousId ? 'twitch-schedule.weekly' : previousId && messageId === previousId ? 'twitch-schedule.updated' : 'twitch-schedule.posted'), () => ({
          title: weeklyDue && previousId ? '🗓️ Schedule Reposted (Weekly)' : previousId && messageId === previousId ? '🔄 Schedule Updated' : '📅 Schedule Posted',
          description: `[${syncConfig.username}'s Twitch schedule](${messageUrl}) in ${channel}.`,
          fields: [
            ['Streamer', syncConfig.username],
            ['Channel', `${channel}`],
            ['Streams listed', scheduleData.segments.length],
            ['Cancelled', canceledSegments.length || null],
          ],
          url: messageUrl,
          avoidChannelIds: [channel.id],
        }));
    } catch (error) {
      if (error?.status || error?.rawError) {
        logger.error(`[TwitchScheduleManager] DISCORD ${error.status} for ${syncConfig.username}: `
          + `${JSON.stringify(error.rawError || {}).slice(0, 600)} | url=${error.url || '?'}`);
      }
      logger.error(`[TwitchScheduleManager] Error syncing schedule for ${syncConfig.username}:`, {
        error: error.message,
        stack: error.stack,
        guildId: syncConfig.guild_id
      });
      logScheduleFailed(this.client, syncConfig, error?.status ? `Discord error ${error.status}: ${error.message}` : error?.message);
    }
  }

  /**
   * Build an embed with the schedule information
   * @param {Object} syncConfig - The sync configuration
   * @param {Object} scheduleData - The schedule data from Twitch
   * @returns {Promise<EmbedBuilder>}
   */

  /**
   * Write the schedule message through plain REST rather than discord.js.
   *
   * discord.js returns HTTP 500 with an empty body for this payload — on edit AND
   * on send — while the identical content posted as hand-built multipart returns
   * 200 every time. That was verified against the real data: 20 segments, the
   * decorated titles, the full 1024-character alt text, with and without the
   * file, at 10/3/0 embed fields. The data is not the problem; the builder is.
   *
   * Returns the message id, or null if the write failed.
   */
  async writeScheduleMessage({ channelId, messageId, content, embed, image, filename, altText }) {
    const token = this.client?.token;
    if (!token) return null;
    const base = `https://discord.com/api/v10/channels/${channelId}/messages`;
    const headers = { Authorization: `Bot ${token}` };

    const payload = { content, embeds: [embed.toJSON ? embed.toJSON() : embed] };
    const form = new FormData();
    if (image) {
      payload.embeds[0].image = { url: `attachment://${filename}` };
      // Naming the attachment explicitly is what lets the embed reference it and
      // what carries the alt text; on an edit it also replaces the old file.
      payload.attachments = [{ id: 0, filename, description: altText }];
    } else if (messageId) {
      /* Dropping the attachment while leaving embed.image pointed at the old CDN
         URL is what produces "image failed to load": the link stays in the embed
         and 404s the moment the file it named is gone. If there is no file this
         time, the image reference has to go with it. */
      delete payload.embeds[0].image;
      payload.attachments = [];
    }
    form.append('payload_json', JSON.stringify(payload));
    if (image) form.append('files[0]', new Blob([image], { type: 'image/png' }), filename);

    const attempt = async (url, method) => {
      const res = await fetch(url, { method, headers, body: form });
      if (res.ok) return res.json();
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body });
    };

    if (messageId) {
      try {
        const msg = await attempt(`${base}/${messageId}`, 'PATCH');
        logger.info(`[TwitchScheduleManager] Edited schedule for ${this._lastUser || 'streamer'}`);
        return msg.id;
      } catch (e) {
        logger.warn(`[TwitchScheduleManager] Edit failed (${e.status}${e.body ? ' ' + e.body.slice(0, 120) : ''}) — posting fresh`);
      }
    }
    try {
      const msg = await attempt(base, 'POST');
      return msg.id;
    } catch (e) {
      logger.error(`[TwitchScheduleManager] Post failed: ${e.status} ${e.body?.slice(0, 200) || ''}`);
      return null;
    }
  }

  async buildScheduleEmbed(syncConfig, scheduleData) {
    const embed = new EmbedBuilder()
      .setColor('#9146FF') // Twitch purple
      .setTitle(`📅 ${syncConfig.username}'s ꜱᴛʀᴇᴀᴍɪɴɢ ꜱᴄʜᴇᴅᴜʟᴇ`)
      .setURL(`https://twitch.tv/${syncConfig.username}`)
      .setTimestamp();

    if (syncConfig.profile_image_url) {
      embed.setThumbnail(syncConfig.profile_image_url);
    }

    /* The same week the card shows, not everything Twitch returns.
     *
     * These layouts draw one week. Listing a month underneath it contradicts the
     * picture — the owner's six-nights-a-week schedule came back as 20 segments
     * and the embed footer announced all of them. The month grid still lists the
     * month, because that is what it draws. */
    const weekly = syncConfig.layout === 'overlay' || syncConfig.layout === 'rows' || syncConfig.layout === 'poster';
    const pool_ = weekly
      ? weekWindow(scheduleData.segments, await getGuildTimezone(syncConfig.guild_id))
      : syncConfig.layout === 'calendar'
        // A filled-in month keeps its past days; the list under the poster is what's still to come.
        ? scheduleData.segments.filter(s => new Date(s.end_time || s.start_time).getTime() > Date.now())
        : scheduleData.segments;
    const segments = pool_.slice(0, 10);

    for (const segment of segments) {
      const startTime = new Date(segment.start_time);
      const discordTimestamp = Math.floor(startTime.getTime() / 1000);

      let fieldValue = `<t:${discordTimestamp}:F> (<t:${discordTimestamp}:R>)`;

      if (segment.category && segment.category.name) {
        fieldValue += `\n🎮 ${segment.category.name}`;
      }

      embed.addFields({
        name: segment.title || 'Scheduled Stream',
        value: fieldValue,
        inline: false
      });
    }

    if (pool_.length > 10) {
      embed.setFooter({
        text: `Showing 10 of ${pool_.length} scheduled streams`
      });
    } else if (weekly && pool_.length) {
      embed.setFooter({
        text: `${pool_.length} stream${pool_.length === 1 ? '' : 's'} scheduled this week`
      });
    }

    return embed;
  }

  /**
   * Dispatcher — picks monthly or weekly renderer based on syncConfig.view_mode.
   * All times are rendered in the guild's configured timezone (or UTC if unset),
   * and segments are bucketed into the guild-local day so a stream that's "tonight"
   * locally never appears under tomorrow's date because of UTC rollover.
   */
  async buildScheduleImage(syncConfig, scheduleData, canceledSegments = [], out = {}) {
    if (!Canvas) return null;
    const segments = scheduleData.segments || [];
    const hasCustomDays = !!syncConfig._customDays?.size;
    if (!segments.length && !canceledSegments.length && !hasCustomDays) return null;

    const tz = await getGuildTimezone(syncConfig.guild_id);
    const referenceDate = new Date(
      (segments[0] || canceledSegments[0])?.start_time || Date.now()
    );
    const zoneAbbr = getZoneAbbreviation(tz, referenceDate);

    /* The month grid is one of three looks now. `layout` decides; anything it
       does not name falls through to the grid this class has always drawn, so a
       guild that never picks a style keeps exactly what it had. */
    const layout = syncConfig.layout || 'month';
    if (layout === 'calendar') {
      const art = await this.buildCalendarPoster(syncConfig, segments, canceledSegments, tz, posterMonth(tz), out);
      if (art) return art;
      logger.warn(`[TwitchSchedule] calendar poster failed for guild ${syncConfig.guild_id}, using the grid`,
        { category: 'twitch' });
    }
    if (layout === 'overlay' || layout === 'rows' || layout === 'exact' || layout === 'poster') {
      const art = await this._buildArtCard(syncConfig, segments, canceledSegments, tz, zoneAbbr, layout, out);
      if (art) return art;
      // Falling through is deliberate: a backdrop that will not load or a
      // renderer that returns nothing must not cost the guild its schedule post.
      logger.warn(`[TwitchSchedule] ${layout} card failed for guild ${syncConfig.guild_id}, using the grid`,
        { category: 'twitch' });
    }

    const mode = syncConfig.view_mode === 'weekly' ? 'weekly' : 'monthly';
    if (mode === 'weekly') {
      return this._buildWeeklyImage(syncConfig, segments, canceledSegments, tz, zoneAbbr);
    }
    return this._buildMonthlyImage(syncConfig, segments, canceledSegments, tz, zoneAbbr);
  }

  /** The month poster. Also what the dashboard preview draws. */
  async buildCalendarPoster(syncConfig, segments, canceledSegments, tz, { year, month }, out = {}) {
    const { drawCalendar } = await import('./schedule-calendar-art.js');
    const days = buildMonth({
      year, month, tz, segments, canceled: canceledSegments,
      source: syncConfig.schedule_source || 'twitch',
      days: syncConfig._customDays || new Map(),
    });
    const name = monthName(year, month);
    const planned = days.filter(d => d.kind === 'stream');
    out.alt = planned.length
      ? `${syncConfig.username}'s ${name} ${year} stream schedule: ${planned.map(d => `${name} ${d.date}, ${d.title}${d.time ? `, ${d.time}` : ''}`).join('; ')}.`
      : `${syncConfig.username}'s ${name} ${year} stream schedule: no streams planned.`;

    let sideArt = null;
    if (syncConfig.side_art_url) {
      const { download } = await import('../utils/schedule-background.js');
      sideArt = await download(syncConfig.side_art_url).catch(e => {
        logger.warn(`[TwitchSchedule] side art failed for guild ${syncConfig.guild_id}: ${e.message}`, { category: 'twitch' });
        return null;
      });
    }
    return drawCalendar({
      monthName: name, year, firstWeekday: firstWeekday(year, month), days,
      title: syncConfig.card_title || 'Stream Schedule',
      disclaimer: syncConfig.card_disclaimer || null,
      sideArt,
    });
  }

  /**
   * The overlay and rows cards. Segments are collapsed to one line per weekday —
   * both layouts are a week at a glance, not a month, and a day with two streams
   * reads better as "8PM, 11PM" than as two rows saying the same weekday twice.
   */
  async _buildArtCard(syncConfig, segments, canceledSegments, tz, zoneAbbr, layout, out = {}) {
    const { renderSchedule } = await import('./schedule-art.js');
    const { resolveBackground } = await import('../utils/schedule-background.js');

    /* One week, not everything Twitch returns.
     *
     * A recurring schedule comes back as 20+ segments stretching a month ahead.
     * Collapsing those by weekday without a window gives "Monday: 10PM, 10PM,
     * 10PM" — the same slot repeated once per week. These layouts show a week. */
    const inWindow = new Set(weekWindow([...segments, ...canceledSegments], tz));

    const byDay = new Map();
    const note = (seg, cancelled) => {
      const start = new Date(seg.start_time);
      const day = formatTimeInZone(start, tz, { weekday: 'long' });
      const time = formatTimeInZone(start, tz, { hour: 'numeric', minute: '2-digit' });
      const end = seg.end_time
        ? formatTimeInZone(new Date(seg.end_time), tz, { hour: 'numeric', minute: '2-digit' })
        : null;
      const entry = byDay.get(day) || { day, times: [], titles: [], cancelled: true };
      // Twitch can hand back the same slot twice; one day never lists a time twice.
      const slot = end ? `${time} – ${end}` : time;
      if (!entry.times.includes(slot)) entry.times.push(slot);
      /* Prefer the CATEGORY over the stream title when the title is decorated.
         *
         * Titles come styled — Mathematical Script letters the display faces have
         * no glyphs for, and emoji scattered through the words. Either way the
         * drawn result is wrong: boxes, or words with pieces missing. The category
         * is the plain game name Twitch already holds, and it is what a schedule
         * card wants to say. A plain title is used as written. */
      const raw = seg.title || seg.category?.name || '';  // use the EXACT Twitch stream title verbatim
      const title = toPlain(raw)
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/\s+/g, ' ').trim();
      if (title && !entry.titles.includes(title)) entry.titles.push(title);
      // A day is only "cancelled" if every stream on it is.
      if (!cancelled) entry.cancelled = false;
      byDay.set(day, entry);
    };
    for (const seg of segments.filter((s) => inWindow.has(s))) note(seg, false);
    for (const seg of canceledSegments.filter((s) => inWindow.has(s))) note(seg, true);
    // Nothing this week is not an error — fall back rather than draw an empty card.
    if (!byDay.size) return null;

    const ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const rows = [...byDay.values()]
      .sort((a, b) => ORDER.indexOf(a.day) - ORDER.indexOf(b.day))
      .map(e => ({
        day: e.day,
        times: e.times,
        zone: zoneAbbr,
        time: `${e.times.join(', ')} ${zoneAbbr}`.trim(),
        title: e.titles.join(' + '),
        cancelled: e.cancelled,
      }));
    if (!rows.length) return null;

    const windowed = [...inWindow]
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    const first = new Date((windowed[0] || segments[0] || canceledSegments[0]).start_time);
    const span = formatTimeInZone(first, tz, { month: 'long', day: 'numeric' });
    out.alt = describeScheduleRows(syncConfig.username, rows, span);

    /* 'exact' layout is a separate pipeline: fetch the raw uploaded image
       (no restyle, no blur), detect panel regions once per uploaded image, and
       hand both to the renderer. If anything in this path fails, fall through
       to the normal background-generation flow so the schedule still ships. */
    if (layout === 'exact' && syncConfig.background_mode === 'exact' && syncConfig.background_url) {
      try {
        const [{ download }, { getCachedPanels }] = await Promise.all([
          import('../utils/schedule-background.js'),
          import('../utils/schedule-panel-detect.js'),
        ]);
        const rawBuffer = await download(syncConfig.background_url);
        const regions = await getCachedPanels(syncConfig, syncConfig.background_url, rawBuffer, pool);
        const ORDER_INLINE = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
        const byDayLocal = new Map();
        const noteLocal = (seg, cancelled) => {
          const start = new Date(seg.start_time);
          const day = formatTimeInZone(start, tz, { weekday: 'long' });
          const time = formatTimeInZone(start, tz, { hour: 'numeric', minute: '2-digit' });
          const end = seg.end_time
            ? formatTimeInZone(new Date(seg.end_time), tz, { hour: 'numeric', minute: '2-digit' })
            : null;
          const entry = byDayLocal.get(day) || { day, times: [], titles: [], cancelled: true };
          const slot = end ? `${time} – ${end}` : time;
          if (!entry.times.includes(slot)) entry.times.push(slot);
          const raw = seg.title || seg.category?.name || '';  // use the EXACT Twitch stream title verbatim
          const title = toPlain(raw).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s+/g, ' ').trim();
          if (title && !entry.titles.includes(title)) entry.titles.push(title);
          if (!cancelled) entry.cancelled = false;
          byDayLocal.set(day, entry);
        };
        const inWindowLocal = new Set(weekWindow([...segments, ...canceledSegments], tz));
        for (const seg of segments.filter(s => inWindowLocal.has(s))) noteLocal(seg, false);
        for (const seg of canceledSegments.filter(s => inWindowLocal.has(s))) noteLocal(seg, true);
        const rowsLocal = [...byDayLocal.values()]
          .sort((a, b) => ORDER_INLINE.indexOf(a.day) - ORDER_INLINE.indexOf(b.day))
          .map(e => ({
            day: e.day, times: e.times, zone: zoneAbbr,
            time: `${e.times.join(', ')} ${zoneAbbr}`.trim(),
            title: e.titles.join(' + '),
            cancelled: e.cancelled,
          }));
        if (regions?.panels?.length) {
          const { renderSchedule } = await import('./schedule-art.js');
          return renderSchedule({
            layout: 'exact',
            title: syncConfig.card_title || syncConfig.username || 'Stream schedule',
            subtitle: `Week of ${formatTimeInZone(new Date((segments[0] || canceledSegments[0])?.start_time || Date.now()), tz, { month: 'long', day: 'numeric' })}`,
            footer: syncConfig.card_footer || `All times ${zoneAbbr}`,
            accent: syncConfig.accent_color || '#C7A5E8',
            rows: rowsLocal,
            imageBuffer: rawBuffer,
            regions,
          });
        }
        logger.warn(`[TwitchSchedule] no panels detected for guild ${syncConfig.guild_id}, using 'rows' fallback`,
          { category: 'twitch' });
      } catch (e) {
        logger.warn(`[TwitchSchedule] exact-mode render failed for guild ${syncConfig.guild_id}: ${e.message}`,
          { category: 'twitch' });
      }
    }

    /* Second exact-mode branch: background_mode='style' means Gemini should
       generate a BLANK stylized template from the owner's reference, and the
       renderer overlays schedule text onto that empty surface using an
       auto-computed 7-panel layout. This is the right path when the owner's
       upload is a FINISHED poster with baked-in text — writing on top of
       baked-in text produces the double-text ugliness that shipped before. */
    if (layout === 'exact' && (syncConfig.background_mode === 'style'
                               || syncConfig.background_mode === 'prompt')) {
      try {
        const { renderSchedule, defaultPanels } = await import('./schedule-art.js');
        const bg = await resolveBackground({ ...syncConfig, layout: 'rows' }, pool);
        if (bg.buffer) {
          // Save the generated template URL so Gemini isn't rebilled every sync.
          if (bg.cacheUrl && bg.cacheUrl !== syncConfig.background_cache_url) {
            await pool.execute(
              'UPDATE twitch_schedule_sync_config SET background_cache_url = ? WHERE id = ?',
              [bg.cacheUrl, syncConfig.id]
            ).catch(() => {});
            const replacedCache = syncConfig.background_cache_url;
            syncConfig.background_cache_url = bg.cacheUrl;
            void discardReplacedUpload(replacedCache, bg.cacheUrl);   // H-706
          }
          const { default: sharp } = await import('sharp');
          const meta = await sharp(bg.buffer).metadata();
          const regions = defaultPanels(meta.width || 1080, meta.height || 1920);
          const ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
          const byDay = new Map();
          const inWindow = new Set(weekWindow([...segments, ...canceledSegments], tz));
          const note = (seg, cancelled) => {
            const start = new Date(seg.start_time);
            const day = formatTimeInZone(start, tz, { weekday: 'long' });
            const time = formatTimeInZone(start, tz, { hour: 'numeric', minute: '2-digit' });
            const end = seg.end_time
              ? formatTimeInZone(new Date(seg.end_time), tz, { hour: 'numeric', minute: '2-digit' })
              : null;
            const entry = byDay.get(day) || { day, times: [], titles: [], cancelled: true };
            const slot = end ? `${time} – ${end}` : time;
            if (!entry.times.includes(slot)) entry.times.push(slot);
            const raw = seg.title || seg.category?.name || '';  // use the EXACT Twitch stream title verbatim
            const title = toPlain(raw)
              .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
              .replace(/\s+/g, ' ').trim();
            if (title && !entry.titles.includes(title)) entry.titles.push(title);
            if (!cancelled) entry.cancelled = false;
            byDay.set(day, entry);
          };
          for (const seg of segments.filter(s => inWindow.has(s))) note(seg, false);
          for (const seg of canceledSegments.filter(s => inWindow.has(s))) note(seg, true);
          const rowsStyle = [...byDay.values()]
            .sort((a, b) => ORDER.indexOf(a.day) - ORDER.indexOf(b.day))
            .map(e => ({
              day: e.day, times: e.times, zone: zoneAbbr,
              time: `${e.times.join(', ')} ${zoneAbbr}`.trim(),
              title: e.titles.join(' + '),
              cancelled: e.cancelled,
            }));
          const windowed = [...inWindow].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
          const first = new Date((windowed[0] || segments[0] || canceledSegments[0]).start_time);
          const spanLabel = formatTimeInZone(first, tz, { month: 'long', day: 'numeric' });
          out.alt = describeScheduleRows(syncConfig.username, rowsStyle, spanLabel);
          return renderSchedule({
            layout: 'exact',
            title: syncConfig.card_title || syncConfig.username || 'Stream schedule',
            subtitle: `Week of ${spanLabel}`,
            footer: syncConfig.card_footer || `All times ${zoneAbbr}`,
            accent: syncConfig.accent_color || '#C7A5E8',
            rows: rowsStyle,
            imageBuffer: bg.buffer,
            regions,
          });
        }
      } catch (e) {
        logger.warn(`[TwitchSchedule] exact+style render failed for guild ${syncConfig.guild_id}: ${e.message}`,
          { category: 'twitch' });
      }
    }

    /* Poster branch — same style pipeline as exact+style (Gemini scrubs text
       off the reference), but renders the Canva-style poster layout: big
       metallic "STREAM SCHEDULE", purple→pink date range, one day per line
       with the stream title as a sub-caption, and a brush-script handle at
       the bottom. Driven by canvas size — no region detection needed. */
    if (layout === 'poster'
        && (syncConfig.background_mode === 'style' || syncConfig.background_mode === 'prompt'
            || syncConfig.background_mode === 'upload')) {
      try {
        const { renderSchedule } = await import('./schedule-art.js');
        const bg = await resolveBackground({ ...syncConfig, layout: 'rows' }, pool);
        if (bg.buffer) {
          if (bg.cacheUrl && bg.cacheUrl !== syncConfig.background_cache_url) {
            await pool.execute(
              'UPDATE twitch_schedule_sync_config SET background_cache_url = ? WHERE id = ?',
              [bg.cacheUrl, syncConfig.id]
            ).catch(() => {});
            const replacedCache = syncConfig.background_cache_url;
            syncConfig.background_cache_url = bg.cacheUrl;
            void discardReplacedUpload(replacedCache, bg.cacheUrl);   // H-706
          }
          const ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
          const byDay = new Map();
          const inWindow = new Set(weekWindow([...segments, ...canceledSegments], tz));
          const note = (seg, cancelled) => {
            const start = new Date(seg.start_time);
            const day = formatTimeInZone(start, tz, { weekday: 'long' });
            const time = formatTimeInZone(start, tz, { hour: 'numeric', minute: '2-digit' });
            const entry = byDay.get(day) || { day, times: [], titles: [], cancelled: true };
            if (!entry.times.includes(time)) entry.times.push(time);
            const title = toPlain(seg.title || seg.category?.name || '')
              .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
              .replace(/\s+/g, ' ').trim();
            if (title && !entry.titles.includes(title)) entry.titles.push(title);
            if (!cancelled) entry.cancelled = false;
            byDay.set(day, entry);
          };
          for (const seg of segments.filter(s => inWindow.has(s))) note(seg, false);
          for (const seg of canceledSegments.filter(s => inWindow.has(s))) note(seg, true);
          const rowsStyle = [...byDay.values()]
            .sort((a, b) => ORDER.indexOf(a.day) - ORDER.indexOf(b.day))
            .map(e => ({
              day: e.day, times: e.times, zone: zoneAbbr,
              title: e.titles.join(' · '),
              cancelled: e.cancelled,
            }));
          const windowed = [...inWindow].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
          const first = windowed.length ? new Date(windowed[0].start_time) : new Date();
          const last  = windowed.length ? new Date(windowed[windowed.length - 1].start_time) : first;
          const fmtMD = (d) => formatTimeInZone(d, tz, { month: 'short', day: 'numeric' });
          const spanText = windowed.length
            ? (fmtMD(first) === fmtMD(last) ? fmtMD(first) : `${fmtMD(first)} to ${fmtMD(last)}`)
            : fmtMD(first);
          out.alt = describeScheduleRows(syncConfig.username, rowsStyle, spanText);
          return renderSchedule({
            layout: 'poster',
            title: syncConfig.card_title || 'Stream Schedule',
            subtitle: spanText,
            footer: syncConfig.card_footer || `@${syncConfig.username} on Twitch`,
            accent: syncConfig.accent_color || '#9146FF',
            rows: rowsStyle,
            imageBuffer: bg.buffer,
          });
        }
      } catch (e) {
        logger.warn(`[TwitchSchedule] poster render failed for guild ${syncConfig.guild_id}: ${e.message}`,
          { category: 'twitch' });
      }
    }


    const { buffer, cacheUrl } = await resolveBackground(syncConfig, pool);
    /* Save the generated artwork URL so we don't rebill the provider every
     * sync. resolveBackground re-downloads from this URL on later calls and
     * only regenerates when the URL stops working or the reference changes. */
    if (cacheUrl && cacheUrl !== syncConfig.background_cache_url) {
      await pool.execute(
        'UPDATE twitch_schedule_sync_config SET background_cache_url = ? WHERE id = ?',
        [cacheUrl, syncConfig.id]
      ).catch(() => {});
      const replacedCache = syncConfig.background_cache_url;
      syncConfig.background_cache_url = cacheUrl;
      void discardReplacedUpload(replacedCache, cacheUrl);   // H-706
    }
    return renderSchedule({
      layout,
      title: syncConfig.card_title || syncConfig.username || 'Stream schedule',
      subtitle: `Twitch schedule · week of ${span}`,
      footer: syncConfig.card_footer || `All times ${zoneAbbr}`,
      accent: syncConfig.accent_color || '#C7A5E8',
      rows,
      mode: buffer ? (syncConfig.background_mode || 'upload') : 'default',
      imageBuffer: buffer,
    });
  }

  /**
   * Render a full-month calendar image of the Twitch schedule. Sun–Sat columns,
   * up to 6 rows of dates, color-coded blocks per stream category. Canceled
   * segments are rendered red with a strikethrough + "CANCELLED" badge.
   *
   * Design inspired by user-supplied reference (docs/April2026.jpg).
   */
  async _buildMonthlyImage(syncConfig, segments, canceledSegments, tz, zoneAbbr) {
    // Pivot to the earliest segment, but bucket by the guild-local calendar.
    const earliest = [...segments, ...canceledSegments]
      .map(s => new Date(s.start_time))
      .sort((a, b) => a - b)[0] || new Date();
    const earliestParts = getLocalDateParts(earliest, tz);
    const year = earliestParts.year;
    const month = earliestParts.month;       // 0-indexed
    const firstParts = getLocalDateParts(new Date(Date.UTC(year, month, 1, 12)), tz);
    const lastParts  = getLocalDateParts(new Date(Date.UTC(year, month + 1, 0, 12)), tz);
    const firstWeekday = firstParts.weekday; // 0 = Sun
    const daysInMonth  = lastParts.day;
    const numRows = Math.ceil((firstWeekday + daysInMonth) / 7);

    // Layout
    const width = 1650, headerHeight = 180, dowHeight = 48, cellHeight = 170, footerHeight = 60;
    const height = headerHeight + dowHeight + cellHeight * numRows + footerHeight;
    const canvas = Canvas.createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFF8E6';
    ctx.fillRect(0, 0, width, height);

    // Header banner
    ctx.fillStyle = '#5E3B1E';
    ctx.fillRect(0, 0, width, headerHeight);
    ctx.fillStyle = '#F5C26B';
    ctx.fillRect(0, headerHeight - 8, width, 8);

    // Title — month name from a date safely inside the local month
    const localMonthAnchor = new Date(Date.UTC(year, month, 15, 12));
    const monthName = formatTimeInZone(localMonthAnchor, tz, { month: 'long', year: 'numeric' });
    const streamerName = (syncConfig.username || 'Streamer');
    ctx.textAlign = 'center';
    ctx.fillStyle = '#F5C26B';
    ctx.font = 'bold italic 60px Arial';
    ctx.fillText(`${streamerName}'s ${monthName}`, width / 2, 80);
    ctx.fillStyle = '#FFEFCE';
    ctx.font = 'italic 36px Arial';
    ctx.fillText('Streaming Schedule', width / 2, 130);
    ctx.fillStyle = '#C7A679';
    ctx.font = '18px Arial';
    ctx.fillText('twitch.tv/' + streamerName, width / 2, 158);

    // Day-of-week header row
    this._drawDowHeader(ctx, headerHeight, dowHeight, width);

    // Index segments by guild-local date-of-month, dropping any that fall
    // outside the rendered month after the TZ shift.
    const byDate = {};
    const indexInto = (list, canceled) => {
      for (const s of list) {
        const p = getLocalDateParts(new Date(s.start_time), tz);
        if (p.year !== year || p.month !== month) continue;
        (byDate[p.day] ||= []).push({ ...s, canceled, _localHour: p.hour, _localMin: p.minute });
      }
    };
    indexInto(segments, false);
    indexInto(canceledSegments, true);

    const colW = width / 7;
    ctx.lineWidth = 1;
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < 7; col++) {
        const idx = row * 7 + col;
        const dateNum = idx - firstWeekday + 1;
        const x = col * colW;
        const y = headerHeight + dowHeight + row * cellHeight;

        ctx.strokeStyle = '#C7A679';
        ctx.strokeRect(x, y, colW, cellHeight);

        if (dateNum < 1 || dateNum > daysInMonth) {
          ctx.fillStyle = '#F0E3C8';
          ctx.fillRect(x + 1, y + 1, colW - 2, cellHeight - 2);
          continue;
        }

        ctx.fillStyle = '#5E3B1E';
        ctx.font = 'bold 22px Arial';
        ctx.textAlign = 'left';
        ctx.fillText(String(dateNum), x + 10, y + 26);

        const segs = (byDate[dateNum] || []).sort((a, b) => a.start_time.localeCompare(b.start_time));
        if (segs.length === 0) {
          ctx.fillStyle = '#E6D6BA';
          ctx.fillRect(x + 6, y + 38, colW - 12, 36);
          ctx.fillStyle = '#7A6A5A';
          ctx.font = 'italic 22px Arial';
          ctx.textAlign = 'center';
          ctx.fillText('No Stream', x + colW / 2, y + 62);
          continue;
        }

        // Up to 2 segments per cell (monthly grid is space-constrained)
        const maxSegs = Math.min(segs.length, 2);
        const blockH = (cellHeight - 44) / maxSegs - 4;
        let sy = y + 38;
        for (let i = 0; i < maxSegs; i++) {
          this._drawSegmentBlock(ctx, segs[i], x + 6, sy, colW - 12, blockH, tz, zoneAbbr, {
            titleMax: 26, categoryMax: 22, titleFont: 'bold 17px Arial', timeFont: 'bold 16px Arial'
          });
          sy += blockH + 4;
        }
      }
    }

    this._drawFooter(ctx, width, height, footerHeight, tz, zoneAbbr);
    return canvas.toBuffer('image/png');
  }

  /**
   * Render a 7-day weekly view. Sun–Sat columns, single tall row, more vertical
   * space per cell so up to 4 segments per day fit without truncation. The week
   * anchor is the Sunday containing (or preceding) the first upcoming/in-progress
   * segment in the guild's local timezone.
   */
  async _buildWeeklyImage(syncConfig, segments, canceledSegments, tz, zoneAbbr) {
    const nowMs = Date.now();
    const upcoming = segments
      .map(s => ({ s, t: new Date(s.start_time).getTime() }))
      .sort((a, b) => a.t - b.t)
      .find(({ s, t }) => t + (60 * 60 * 1000) > nowMs);   // first stream not finished an hour ago
    const anchorInstant = upcoming ? new Date(upcoming.s.start_time) : new Date();
    const anchorParts = getLocalDateParts(anchorInstant, tz);

    // Walk back to the Sunday of the anchor's week (in tz).
    // Build a UTC midnight for the anchor day, then subtract `weekday` days. The
    // resulting instant lives somewhere in Sunday in `tz` regardless of offset.
    const anchorUtcNoon = new Date(Date.UTC(anchorParts.year, anchorParts.month, anchorParts.day, 12));
    const sundayInstant = new Date(anchorUtcNoon.getTime() - anchorParts.weekday * 86_400_000);

    const days = [];
    for (let i = 0; i < 7; i++) {
      const dayInstant = new Date(sundayInstant.getTime() + i * 86_400_000);
      const p = getLocalDateParts(dayInstant, tz);
      days.push({ ...p, segments: [] });
    }

    // Bucket segments by guild-local Y/M/D match against `days`.
    const indexInto = (list, canceled) => {
      for (const s of list) {
        const p = getLocalDateParts(new Date(s.start_time), tz);
        const slot = days.findIndex(d => d.year === p.year && d.month === p.month && d.day === p.day);
        if (slot === -1) continue;
        days[slot].segments.push({ ...s, canceled, _localHour: p.hour, _localMin: p.minute });
      }
    };
    indexInto(segments, false);
    indexInto(canceledSegments, true);

    // Layout — fewer cells but each is much taller so 4 segments + meta fit.
    const width = 1650, headerHeight = 180, dowHeight = 60, cellHeight = 480, footerHeight = 60;
    const height = headerHeight + dowHeight + cellHeight + footerHeight;
    const canvas = Canvas.createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFF8E6';
    ctx.fillRect(0, 0, width, height);

    // Header banner
    ctx.fillStyle = '#5E3B1E';
    ctx.fillRect(0, 0, width, headerHeight);
    ctx.fillStyle = '#F5C26B';
    ctx.fillRect(0, headerHeight - 8, width, 8);

    const streamerName = (syncConfig.username || 'Streamer');
    const weekStartLabel = formatTimeInZone(sundayInstant, tz, { month: 'long', day: 'numeric' });
    const weekEndInstant = new Date(sundayInstant.getTime() + 6 * 86_400_000);
    const weekEndLabel = formatTimeInZone(weekEndInstant, tz, { month: 'long', day: 'numeric', year: 'numeric' });
    ctx.textAlign = 'center';
    ctx.fillStyle = '#F5C26B';
    ctx.font = 'bold italic 56px Arial';
    ctx.fillText(`${streamerName}'s Week`, width / 2, 76);
    ctx.fillStyle = '#FFEFCE';
    ctx.font = 'italic 32px Arial';
    ctx.fillText(`${weekStartLabel} – ${weekEndLabel}`, width / 2, 124);
    ctx.fillStyle = '#C7A679';
    ctx.font = '18px Arial';
    ctx.fillText('twitch.tv/' + streamerName, width / 2, 158);

    // Day-of-week header row — show Sun/Mon/etc. + the local date number
    ctx.fillStyle = '#EEDBB6';
    ctx.fillRect(0, headerHeight, width, dowHeight);
    ctx.strokeStyle = '#C7A679';
    ctx.lineWidth = 1;
    const colW = width / 7;
    const dowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i++) {
      ctx.strokeRect(i * colW, headerHeight, colW, dowHeight);
      ctx.fillStyle = '#5E3B1E';
      ctx.textAlign = 'center';
      ctx.font = 'bold 22px Arial';
      ctx.fillText(dowLabels[i], i * colW + colW / 2, headerHeight + 26);
      ctx.font = '18px Arial';
      ctx.fillText(String(days[i].day), i * colW + colW / 2, headerHeight + 50);
    }

    // Render each day cell
    const cellY = headerHeight + dowHeight;
    for (let i = 0; i < 7; i++) {
      const x = i * colW;
      ctx.strokeStyle = '#C7A679';
      ctx.strokeRect(x, cellY, colW, cellHeight);

      const segs = days[i].segments.sort((a, b) => a.start_time.localeCompare(b.start_time));
      if (segs.length === 0) {
        ctx.fillStyle = '#E6D6BA';
        ctx.fillRect(x + 8, cellY + 16, colW - 16, 56);
        ctx.fillStyle = '#7A6A5A';
        ctx.font = 'italic 26px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('No Stream', x + colW / 2, cellY + 52);
        continue;
      }

      // Up to 4 segments — weekly cells are 2.8× taller than monthly so we
      // can show more streams per day without unreadable squish.
      const maxSegs = Math.min(segs.length, 4);
      const innerH = cellHeight - 16;
      const blockH = (innerH / maxSegs) - 8;
      let sy = cellY + 12;
      for (let j = 0; j < maxSegs; j++) {
        this._drawSegmentBlock(ctx, segs[j], x + 8, sy, colW - 16, blockH, tz, zoneAbbr, {
          titleMax: 28, categoryMax: 24, titleFont: 'bold 20px Arial', timeFont: 'bold 18px Arial', categoryFont: '16px Arial'
        });
        sy += blockH + 8;
      }
      if (segs.length > maxSegs) {
        ctx.fillStyle = '#7A6A5A';
        ctx.font = 'italic 14px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(`+${segs.length - maxSegs} more`, x + colW / 2, cellY + cellHeight - 8);
      }
    }

    this._drawFooter(ctx, width, height, footerHeight, tz, zoneAbbr);
    return canvas.toBuffer('image/png');
  }

  // ─── Shared rendering helpers ───────────────────────────────────────────────

  /** Sun–Sat header row for the monthly grid. */
  _drawDowHeader(ctx, headerHeight, dowHeight, width) {
    ctx.fillStyle = '#EEDBB6';
    ctx.fillRect(0, headerHeight, width, dowHeight);
    ctx.strokeStyle = '#C7A679';
    ctx.lineWidth = 1;
    const colW = width / 7;
    const dowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i++) {
      ctx.strokeRect(i * colW, headerHeight, colW, dowHeight);
      ctx.fillStyle = '#5E3B1E';
      ctx.font = 'bold 24px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(dowLabels[i], i * colW + colW / 2, headerHeight + 32);
    }
  }

  /** Footer bar — always reflects the guild's TZ. */
  _drawFooter(ctx, width, height, footerHeight, tz, zoneAbbr) {
    ctx.fillStyle = '#5E3B1E';
    ctx.fillRect(0, height - footerHeight, width, footerHeight);
    ctx.fillStyle = '#FFEFCE';
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'left';
    const tzNote = zoneAbbr === tz ? zoneAbbr : `${zoneAbbr} (${tz})`;
    ctx.fillText(`*** ALL TIMES ARE IN ${tzNote} UNLESS OTHERWISE NOTED ***`, 30, height - 24);
    ctx.textAlign = 'right';
    ctx.font = '16px Arial';
    const updated = formatTimeInZone(new Date(), tz, { dateStyle: 'medium', timeStyle: 'short' });
    ctx.fillText(`Updated ${updated} ${zoneAbbr}`, width - 30, height - 24);
  }

  /**
   * Draw a single stream block (rectangle + title + category + time).
   * Shared by the monthly and weekly renderers so they always agree on style.
   */
  _drawSegmentBlock(ctx, s, x, y, w, h, tz, zoneAbbr, opts = {}) {
    const {
      titleMax = 26, categoryMax = 22,
      titleFont = 'bold 17px Arial',
      timeFont = 'bold 16px Arial',
      categoryFont = '14px Arial'
    } = opts;

    const color = s.canceled ? '#E8ADAD' : strToColor(s.category?.name || s.title);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = s.canceled ? '#B33A3A' : '#BDA47A';
    ctx.strokeRect(x, y, w, h);

    const title = (s.title || 'Stream').slice(0, titleMax);
    const category = (s.category?.name || '').slice(0, categoryMax);
    const startLocal = formatTimeInZone(new Date(s.start_time), tz, {
      hour: 'numeric', minute: '2-digit'
    });

    ctx.textAlign = 'center';
    ctx.fillStyle = s.canceled ? '#8B2C2C' : '#3D2B1F';
    ctx.font = titleFont;
    const titleY = y + 24;
    const titleText = s.canceled ? 'CANCELLED' : title;
    ctx.fillText(titleText, x + w / 2, titleY);
    if (s.canceled) {
      const tw = ctx.measureText(titleText).width;
      ctx.strokeStyle = '#8B2C2C';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + w / 2 - tw / 2 - 3, titleY - 5);
      ctx.lineTo(x + w / 2 + tw / 2 + 3, titleY - 5);
      ctx.stroke();
    }
    if (!s.canceled && category) {
      ctx.fillStyle = '#5E3B1E';
      ctx.font = categoryFont;
      ctx.fillText(category, x + w / 2, titleY + 22);
    }
    ctx.fillStyle = s.canceled ? '#8B2C2C' : '#5E3B1E';
    ctx.font = timeFont;
    ctx.fillText(`${startLocal} ${zoneAbbr}`, x + w / 2, y + h - 10);
  }

  /**
   * The schedule's channel could not be fetched (H-312). Until 2026-11-18 a sync whose channel or
   * server was gone warned on every tick forever (513 warnings in 48 h for one sync) and the server
   * was never told. Now:
   *   - Unknown Channel (10003), or the channel missing from a server this bot has cached: the
   *     channel was deleted. Pause with reason channel_deleted, tell the server once in its log
   *     channel; the dashboard shows "Paused: channel deleted" with a channel picker.
   *   - No bot of ours is in the server (and bots are not still starting): pause with reason
   *     guild_left; processAllSyncs resumes it if a bot is back.
   *   - Anything else (missing permission, network): keep retrying, warn once per 6 hours.
   */
  async handleMissingChannel(syncConfig, channelError) {
    const guildId = syncConfig.guild_id;
    const channelId = syncConfig.discord_channel_id;
    const guild = this.client.guilds.cache.get(guildId);
    const bm = global.botManager;
    let reason = null;
    if (guild) {
      if (channelError?.code === 10003 || (!channelError && !guild.channels.cache.has(channelId))) reason = 'channel_deleted';
    } else if (this.client.isReady?.() && !bm?.isStarting?.() && !servedByAnotherClient(bm, guildId, this.client)) {
      reason = 'guild_left';
    }

    if (reason && await this.pauseSync(syncConfig, reason)) {
      logger.warn(`[TwitchScheduleManager] Paused schedule sync ${syncConfig.id} (${syncConfig.username}) in guild ${guildId}: ${reason === 'channel_deleted' ? `channel ${channelId} was deleted` : 'no bot of ours is in that server'}`, {
        guildId, channelId, reason, error: channelError?.message,
      });
      missingChannelWarnedAt.delete(syncConfig.id);
      if (reason === 'channel_deleted') {
        void logFeatureEvent(() => guild, 'system.featureDisabled', () => ({
          title: '⛔ Feature Auto-Disabled',
          fields: [
            ['Feature', 'Twitch schedule sync'], ['Streamer', syncConfig.username],
            ['Why', `Its channel (${channelId}) was deleted`],
            ['Fix', 'Pick a new channel for it on the Twitch Schedules page; it starts posting again there', false],
          ],
        }));
      }
      return;
    }

    const last = missingChannelWarnedAt.get(syncConfig.id) || 0;
    if (Date.now() - last >= MISSING_CHANNEL_WARN_MS) {
      missingChannelWarnedAt.set(syncConfig.id, Date.now());
      logger.warn(`[TwitchScheduleManager] Channel ${channelId} not reachable for guild ${guildId} (sync ${syncConfig.id}, ${syncConfig.username}): ${channelError?.message || 'not in cache'}. Retrying; next warning in 6 hours`, {
        guildId, channelId, code: channelError?.code,
      });
      if (guild) logScheduleFailed(this.client, syncConfig, `The bot cannot open the schedule channel: ${channelError?.message || 'not visible to the bot'}`);
    }
  }

  /** Switch a sync off and record why. False when nothing was changed. */
  async pauseSync(syncConfig, reason) {
    try {
      const [res] = await pool.execute(
        'UPDATE twitch_schedule_sync_config SET is_enabled = 0, paused_reason = ?, paused_at = NOW() WHERE id = ? AND is_enabled = 1',
        [reason, syncConfig.id]);
      return res.affectedRows > 0;
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      // Migration 434 not applied yet. A deleted channel never comes back, so switch it off anyway;
      // a server we left might take the bot back, and without the reason column it could never be
      // resumed automatically, so leave that one running (its warning is throttled above).
      if (reason !== 'channel_deleted') return false;
      const [res] = await pool.execute('UPDATE twitch_schedule_sync_config SET is_enabled = 0 WHERE id = ? AND is_enabled = 1', [syncConfig.id]);
      return res.affectedRows > 0;
    }
  }

  /** Resume guild_left syncs for servers this bot is back in. */
  async resumeReturnedGuilds() {
    let rows;
    try {
      [rows] = await pool.execute("SELECT id, guild_id FROM twitch_schedule_sync_config WHERE paused_reason = 'guild_left'");
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') return;
      throw e;
    }
    const back = rows.filter(r => this.client.guilds.cache.has(r.guild_id)).map(r => r.id);
    if (!back.length) return;
    await pool.query(
      "UPDATE twitch_schedule_sync_config SET is_enabled = 1, paused_reason = NULL, paused_at = NULL WHERE paused_reason = 'guild_left' AND id IN (?)",
      [back]);
    logger.info(`[TwitchScheduleManager] Resumed ${back.length} schedule sync(s): the bot is back in their server`, { ids: back });
  }

  /**
   * Process all enabled schedule syncs.
   * Skips syncs whose sync_interval_minutes hasn't elapsed since last_synced
   * AND which are not due for a weekly refresh — avoids redundant Twitch API calls.
   */
  async processAllSyncs() {
    try {
      await this.resumeReturnedGuilds().catch(e => logger.warn(`[TwitchScheduleManager] Could not check paused syncs: ${e.message}`));
      const syncs = await this.getEnabledSyncs();

      if (syncs.length === 0) {
        logger.debug(`[TwitchScheduleManager] No enabled schedule syncs for bot ${this.client.botId || 'default'}`);
        return;
      }

      const now = Date.now();
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

      const due = syncs.filter(sync => {
        // One-shot operator-triggered refresh — always due, bypasses cooldown
        // (handled by passing skipCooldown:true below).
        if (sync.force_refresh) return true;
        // Due for weekly refresh? Never skip even if interval hasn't elapsed.
        if (sync.weekly_refresh) {
          const lastWeekly = sync.last_weekly_refresh ? new Date(sync.last_weekly_refresh).getTime() : 0;
          if (now - lastWeekly >= WEEK_MS) return true;
        }
        // First sync ever — always due
        if (!sync.last_synced) return true;
        // Check per-sync interval
        const interval = Math.max(15, sync.sync_interval_minutes || 360);
        const lastSynced = new Date(sync.last_synced).getTime();
        return (now - lastSynced) >= interval * 60 * 1000;
      });

      if (due.length === 0) {
        logger.debug(`[TwitchScheduleManager] No syncs due right now (${syncs.length} total, all within their intervals) for bot ${this.client.botId || 'default'}`);
        return;
      }

      logger.info(`[TwitchScheduleManager] Processing ${due.length}/${syncs.length} due schedule sync(s) for bot ${this.client.botId || 'default'}`);

      for (const sync of due) {
        await this.syncSchedule(sync, { skipCooldown: !!sync.force_refresh });

        // Add a small delay between syncs to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      logger.error('[TwitchScheduleManager] Error processing syncs:', {
        error: error.message,
        stack: error.stack
      });
    }
  }
}

/**
 * The eight days the card actually draws.
 *
 * A recurring Twitch schedule answers with a month or more of segments — 20+ for
 * a six-night-a-week streamer. Everything the viewer reads has to agree with the
 * picture beside it, so the window is defined once here and used by the card, the
 * embed's list, and the alt text alike. Yesterday is included: a stream that ran
 * last night is still part of "this week" to someone reading in the morning.
 */
export function weekWindow(segments = [], tz = 'UTC') {
  /* Seven guild-local calendar days, starting on the day of the first stream
     that has not already passed.
   *
   * This used to be "yesterday through eight days out" — nine days, so a weekly
   * schedule always caught next week's Monday and Tuesday too, and the card drew
   * "10:00 PM – 12:30 AM, 10:00 PM – 12:30 AM" on those rows. Calendar days in the
   * guild's zone guarantee each weekday appears at most once. */
  const now = Date.now();
  const dated = segments
    .map((seg) => ({ seg, t: new Date(seg?.start_time).getTime() }))
    .filter(({ t }) => Number.isFinite(t));
  const anchor = dated
    .filter(({ t }) => t >= now - 86400000)
    .sort((a, b) => a.t - b.t)[0];
  if (!anchor) return [];
  const dayKey = (t) => {
    const p = getLocalDateParts(new Date(t), tz);
    return Date.UTC(p.year, p.month, p.day);
  };
  const first = dayKey(anchor.t);
  return dated
    .filter(({ t }) => { const k = dayKey(t); return k >= first && k < first + 7 * 86400000; })
    .map(({ seg }) => seg);
}

/**
 * Alt text for a card, written from the rows the card drew.
 *
 * Describing the raw API response instead produced "20 scheduled streams this
 * week" over a picture of six — the segments stretched a month ahead and the
 * count came from all of them. The rows are the only honest source: one line per
 * day, already collapsed and already windowed.
 */
function describeScheduleRows(username, rows, spanLabel) {
  const live = rows.filter((r) => !r.cancelled);
  const dead = rows.filter((r) => r.cancelled);
  const week = spanLabel ? ` for the week of ${spanLabel}` : '';
  if (!live.length && !dead.length) return `${username} has no streams scheduled${week}.`;

  const say = (r) => `${r.day} ${r.time}${r.title ? `: ${r.title}` : ''}`;
  const head = live.length
    ? `${live.length} streaming ${live.length === 1 ? 'day' : 'days'}${week}. `
    : `No streams going ahead${week}. `;
  const cancelled = dead.length
    ? ` Cancelled: ${dead.map(say).join('. ')}.`
    : '';
  return `${username}'s streaming schedule. ${head}${live.map(say).join('. ')}.${cancelled}`;
}

/**
 * Text rendering of the weekly stream schedule graphic.
 *
 * The image is the whole point of this feature — a subscriber checking when
 * their streamer is live next gets nothing from it without sight. The embed
 * beside it carries some of this, but not the per-day breakdown, and the
 * cancellations only exist as strikethrough in the picture.
 */
function describeTwitchSchedule(username, segments = [], canceledSegments = []) {
  if (!segments.length) return `${username} has no streams scheduled.`;

  const fmt = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? 'time to be confirmed'
      : d.toLocaleString('en-US', {
          weekday: 'long', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
        });
  };

  const lines = segments.map((seg) => {
    const what = seg.title || 'Untitled stream';
    const cat = seg.category?.name ? ` (${seg.category.name})` : '';
    return `${fmt(seg.start_time)}: ${what}${cat}`;
  });

  const canceled = canceledSegments.length
    ? ` ${canceledSegments.length} stream${canceledSegments.length === 1 ? '' : 's'} cancelled: ` +
      canceledSegments.map((c) => `${c.title || 'Untitled'} on ${fmt(c.start_time)}`).join('; ') + '.'
    : '';

  return `${username}'s streaming schedule. ${segments.length} stream${segments.length === 1 ? '' : 's'} scheduled. ` +
    `${lines.join('. ')}.${canceled}`;
}

