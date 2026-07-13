import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes, ButtonStyle } from 'discord-api-types/v10';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { getTwitchUsers } from '../utils/platforms/twitch-api.js';

const GUILD_ID = '1469931133981687873';
const KITSUNE_BOT_ID = '1498486251576229958';
// Default bot is not in this guild — token gets swapped to Kitsune's during
// loadKitsuneRest() at the top of main(). Same REST instance is used
// throughout; `kitsuneRest` aliases it for clarity at panel-post sites.
const rest = new REST({ version: '10' });
let kitsuneRest = null;

const PERM = {
  VIEW_CHANNEL:         1n << 10n,
  SEND_MESSAGES:        1n << 11n,
  MANAGE_CHANNELS:      1n << 4n,
  MANAGE_MESSAGES:      1n << 13n,
  EMBED_LINKS:          1n << 14n,
  ATTACH_FILES:         1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
};

const CHANNELS = {
  selfRole:     '1470817784471621868',  // #self-role — Stream Notifications panel
  welcome:      '1469931472054911133',  // #welcome
  goodbye:      '1470598820172795945',  // #good-bye
  founders:     '1470671744946933873',  // #founders-strm
  vips:         '1470107240265683006',  // #vips
  loveMods:     '1491131042348929044',  // #love-mods
  onTheAir:     '1486042994103812218',  // #on-the-air (Pnay YouTube uploads)
  selfPromo:    '1470600196131000340',  // #self-promo
  rankUp:       '1470602184076034068',  // #rank-up-level-up
  general:      '1469931134845456532',  // #🗣️𝑔𝑒𝓃𝑒𝓇𝒶𝓁  (default birthday channel)
  announcements:'1469931444167246025',  // #📣𝒦𝒾𝓉𝓈𝓊𝓃𝑒-𝒜𝓃𝓃𝑜𝓊𝓃𝒸𝑒𝓂𝑒𝓃𝓉  (default free-games / patch channel)
  jtcTrigger:   '1471385969398775822',  // #𝒥𝑜𝒾𝓃 𝓉𝑜 𝒞𝓇𝑒𝒶𝓉𝑒  (VoiceMaster trigger; CertiFried takes over after kick)
  jtcCategory:  '1469931134845456534',  // 🎀 𝐻𝑒𝓁𝓁🏵 voice category
};

const STREAM_ROLES = [
  { key: 'founders', name: 'Founders Streams', color: 0xFFD700, emoji: '🎥', style: 'primary',   channel: CHANNELS.founders },
  { key: 'vip',      name: 'VIP Streams',      color: 0xA569BD, emoji: '💎', style: 'secondary', channel: CHANNELS.vips     },
  { key: 'mods',     name: 'Mod Streams',      color: 0x5865F2, emoji: '🛡️', style: 'success',   channel: CHANNELS.loveMods },
  { key: 'pnay',     name: 'Pnay Updates',     color: 0xE91E63, emoji: '✨', style: 'danger',    channel: CHANNELS.onTheAir },
];

const STREAMER_ROUTES = [
  { username: 'forsaken_ichigo',   platform: 'twitch', tier: 'founders' },
  { username: 'forsakenpnay',      platform: 'twitch', tier: 'founders' },
  { username: 'blue_collar_mike',  platform: 'twitch', tier: 'founders' },
  { username: 'redrum_615',        platform: 'twitch', tier: 'vip' },
  { username: 'xbatmangoddessx',   platform: 'twitch', tier: 'vip' },
  { username: 'shinobijedji13',    platform: 'twitch', tier: 'vip' },
  { username: 'anathebananagg',    platform: 'twitch', tier: 'vip' },
  { username: 'wolfzgangz',        platform: 'twitch', tier: 'mods' },
  { username: 'mamabear_xal',      platform: 'twitch', tier: 'mods' },
  { username: 'drag0n190',         platform: 'twitch', tier: 'mods' },
  { username: 'hibinforsaken',     platform: 'twitch', tier: 'mods' },
  { username: 'fall3nking',        platform: 'twitch', tier: 'mods' },
  { username: 'forsakendarkwolf',  platform: 'twitch', tier: 'mods' },
  { username: 'karlogeetv',        platform: 'twitch', tier: 'mods' },
];

const log = (...a) => console.log('[setup]', ...a);

async function ensureStreamRoles() {
  const existingRoles = await rest.get(Routes.guildRoles(GUILD_ID));
  const out = {};
  for (const def of STREAM_ROLES) {
    const existing = existingRoles.find(r => r.name === def.name);
    if (existing) {
      log(`role "${def.name}" exists → ${existing.id}${existing.mentionable ? '' : ' (making mentionable)'}`);
      if (!existing.mentionable) {
        await rest.patch(Routes.guildRole(GUILD_ID, existing.id), { body: { mentionable: true } });
      }
      out[def.key] = existing.id;
    } else {
      const created = await rest.post(Routes.guildRoles(GUILD_ID), {
        body: { name: def.name, color: def.color, mentionable: true, hoist: false, permissions: '0' }
      });
      log(`role "${def.name}" created → ${created.id}`);
      out[def.key] = created.id;
    }
  }
  return out;
}

async function ensureStreamPanel(roleIds) {
  const PANEL_NAME = 'Stream Notifications';
  const [existing] = await pool.execute(
    'SELECT * FROM reaction_role_panels WHERE guild_id = ? AND panel_name = ? LIMIT 1',
    [GUILD_ID, PANEL_NAME]
  );

  const description =
    'Pick which streams you want pinged for. Click any button to toggle that notification on or off — choose any combination, or none if you\'d rather check the channels manually.\n\n' +
    `🎥 **Founders Streams** → <#${CHANNELS.founders}>\n` +
    `💎 **VIP Streams** → <#${CHANNELS.vips}>\n` +
    `🛡️ **Mod Streams** → <#${CHANNELS.loveMods}>\n` +
    `✨ **Pnay Updates** → <#${CHANNELS.onTheAir}>\n`;

  const components = [{
    type: 1, // ACTION_ROW
    components: STREAM_ROLES.map(def => ({
      type: 2, // BUTTON
      style: { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger }[def.style],
      label: def.name,
      emoji: { name: def.emoji },
      custom_id: 'rr_' + roleIds[def.key]
    }))
  }];

  const embed = {
    title: '🔔 Stream Notifications',
    description,
    color: 0x5865F2,
    footer: { text: 'Toggle a button to add/remove that role.' }
  };

  let messageId = null;
  let panelId = null;

  if (existing.length) {
    panelId = existing[0].id;
    try {
      await rest.patch(Routes.channelMessage(existing[0].channel_id, existing[0].message_id), {
        body: { embeds: [embed], components }
      });
      messageId = existing[0].message_id;
      log(`panel "${PANEL_NAME}" updated in place → message ${messageId}`);
    } catch (e) {
      log(`existing panel message lost (${e.message}) — posting fresh`);
      const sent = await rest.post(Routes.channelMessages(CHANNELS.selfRole), { body: { embeds: [embed], components } });
      messageId = sent.id;
      await pool.execute('UPDATE reaction_role_panels SET message_id = ?, channel_id = ? WHERE id = ?', [messageId, CHANNELS.selfRole, panelId]);
    }
    await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [panelId]);
  } else {
    const sent = await rest.post(Routes.channelMessages(CHANNELS.selfRole), { body: { embeds: [embed], components } });
    messageId = sent.id;
    log(`panel "${PANEL_NAME}" posted → message ${messageId}`);
    const [ins] = await pool.execute(
      `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type, max_selections, placeholder_text)
       VALUES (?, ?, ?, ?, ?, ?, 'standard', 'button', 4, 'Choose your stream alerts')`,
      [GUILD_ID, CHANNELS.selfRole, messageId, PANEL_NAME, description, '#5865F2']
    );
    panelId = ins.insertId;
  }

  for (const def of STREAM_ROLES) {
    await pool.execute(
      'INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id) VALUES (?, ?, ?, ?, ?)',
      [panelId, def.emoji, def.name, def.style, roleIds[def.key]]
    );
  }
  log(`reaction_role_mappings: ${STREAM_ROLES.length} buttons wired to panel ${panelId}`);
  return { panelId, messageId };
}

async function ensureStreamerRow(platform, username, twitchIdMap) {
  const norm = username.toLowerCase();
  const [hits] = await pool.execute(
    'SELECT streamer_id FROM streamers WHERE platform = ? AND (LOWER(username) = ? OR LOWER(normalized_username) = ?) LIMIT 1',
    [platform, norm, norm]
  );
  if (hits.length) return hits[0].streamer_id;

  let platformUserId = twitchIdMap?.get(norm) || ('temp_' + norm);
  let resolvedDisplayName = username;
  let profileImage = null;
  if (twitchIdMap?.has(norm)) {
    const u = twitchIdMap.get(norm + ':__obj');
    if (u) {
      resolvedDisplayName = u.display_name || username;
      profileImage = u.profile_image_url || null;
    }
  }

  const [ins] = await pool.execute(
    'INSERT INTO streamers (platform, platform_user_id, username, normalized_username, guild_id, profile_image_url) VALUES (?, ?, ?, ?, ?, ?)',
    [platform, platformUserId, resolvedDisplayName, norm, GUILD_ID, profileImage]
  );
  log(`streamers: created ${platform}:${username} → ${ins.insertId}  (platform_user_id=${platformUserId})`);
  return ins.insertId;
}

async function configureSubscriptions(roleIds) {
  const tierToChannel = {
    founders: CHANNELS.founders,
    vip:      CHANNELS.vips,
    mods:     CHANNELS.loveMods,
  };
  const tierToRoleKey = { founders: 'founders', vip: 'vip', mods: 'mods' };

  // Batch-resolve Twitch IDs upfront so new streamer rows get real platform_user_ids.
  const twitchUsernames = STREAMER_ROUTES.filter(r => r.platform === 'twitch').map(r => r.username.toLowerCase());
  const twitchIdMap = new Map();
  try {
    const users = await getTwitchUsers(twitchUsernames);
    for (const u of users) {
      twitchIdMap.set(u.login.toLowerCase(), u.id);
      twitchIdMap.set(u.login.toLowerCase() + ':__obj', u);
    }
    log(`resolved ${users.length}/${twitchUsernames.length} Twitch user IDs`);
    const missing = twitchUsernames.filter(n => !twitchIdMap.has(n));
    if (missing.length) log(`  unresolved (will use temp_*): ${missing.join(', ')}`);
  } catch (e) {
    log(`Twitch API lookup failed (${e.message}) — falling back to temp_ placeholders for new rows`);
  }

  let touched = 0;
  for (const r of STREAMER_ROUTES) {
    const streamerId = await ensureStreamerRow(r.platform, r.username, twitchIdMap);
    const announcementChannel = tierToChannel[r.tier];
    const pingRoleId = roleIds[tierToRoleKey[r.tier]];

    const [existing] = await pool.execute(
      'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? LIMIT 1',
      [GUILD_ID, streamerId]
    );

    if (existing.length) {
      await pool.execute(
        `UPDATE subscriptions
            SET announcement_channel_id = ?,
                ping_role_id = ?,
                notify_videos = ?,
                video_announcement_channel_id = ?,
                paused = 0
          WHERE subscription_id = ?`,
        [announcementChannel, pingRoleId, r.notifyVideos ? 1 : 0, r.videoChannel || null, existing[0].subscription_id]
      );
      log(`sub UPDATE  ${r.platform}:${r.username}  chan=${announcementChannel}  ping=${pingRoleId}${r.notifyVideos ? '  +videos→' + r.videoChannel : ''}`);
    } else {
      await pool.execute(
        `INSERT INTO subscriptions
          (guild_id, streamer_id, announcement_channel_id, ping_role_id, notify_videos, video_announcement_channel_id, paused, delete_on_end, edit_on_end)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)`,
        [GUILD_ID, streamerId, announcementChannel, pingRoleId, r.notifyVideos ? 1 : 0, r.videoChannel || null]
      );
      log(`sub INSERT  ${r.platform}:${r.username}  chan=${announcementChannel}  ping=${pingRoleId}${r.notifyVideos ? '  +videos→' + r.videoChannel : ''}`);
    }
    touched++;
  }
  return touched;
}

async function loadAllowlistStreamerIds() {
  const usernames = STREAMER_ROUTES.map(r => r.username.toLowerCase());
  const placeholders = usernames.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT streamer_id, LOWER(username) AS username FROM streamers
      WHERE platform = 'twitch'
        AND (LOWER(username) IN (${placeholders}) OR LOWER(normalized_username) IN (${placeholders}))`,
    [...usernames, ...usernames]
  );
  const byUsername = new Map();
  for (const r of rows) byUsername.set(r.username, r.streamer_id);
  for (const u of usernames) {
    if (!byUsername.has(u)) log(`WARN  allowlist streamer not yet in DB: ${u}`);
  }
  return byUsername;
}

async function scrapeFounderSayings(founderUsernames) {
  const founderSet = new Set(founderUsernames.map(u => u.toLowerCase()));
  const sayings = new Map();
  const MAX_PAGES = 10;          // 10 × 100 = up to 1000 messages
  const PAGE_LIMIT = 100;
  let before = null;
  let scanned = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (before) qs.set('before', before);
    const url = `${Routes.channelMessages(CHANNELS.founders)}?${qs.toString()}`;
    let batch;
    try {
      batch = await kitsuneRest.get(url);
    } catch (e) {
      log(`scrape: REST error on page ${page} — ${e.message}`);
      break;
    }
    if (!batch?.length) break;
    scanned += batch.length;

    for (const m of batch) {
      if (!m.author?.bot) continue;
      if (!m.embeds?.length) continue;
      const e = m.embeds[0];

      let matched = null;
      const urls = [e.author?.url, e.url].filter(Boolean);
      for (const u of urls) {
        const m2 = u.match(/twitch\.tv\/([^/?#]+)/i);
        if (m2 && founderSet.has(m2[1].toLowerCase())) { matched = m2[1].toLowerCase(); break; }
      }
      if (!matched && e.author?.name) {
        const an = e.author.name.toLowerCase();
        for (const fu of founderSet) {
          if (an === fu || an.includes(fu)) { matched = fu; break; }
        }
      }
      if (!matched) continue;

      const content = (m.content || '').trim();
      if (!content) continue;
      // Keep the most recent (earliest seen, since pagination walks backward in time).
      if (!sayings.has(matched)) {
        sayings.set(matched, content);
        log(`scrape: found saying for ${matched} → "${content.slice(0, 80).replace(/\n/g, ' ')}${content.length > 80 ? '…' : ''}"`);
      }
    }

    before = batch[batch.length - 1].id;
    if (batch.length < PAGE_LIMIT) break;
    if (sayings.size === founderSet.size) break; // all founders covered, stop early
  }

  log(`scrape: scanned ${scanned} messages in <#${CHANNELS.founders}>; matched ${sayings.size}/${founderSet.size} founders`);
  for (const fu of founderSet) {
    if (!sayings.has(fu)) log(`scrape: NO saying recovered for ${fu} — custom_message will stay NULL`);
  }
  return sayings;
}

async function applyFounderSayings(sayingsMap, streamerIdByUsername) {
  let updated = 0;
  for (const [username, text] of sayingsMap) {
    const streamerId = streamerIdByUsername.get(username);
    if (!streamerId) {
      log(`saying skip: no streamer_id for ${username}`);
      continue;
    }
    if (!text?.trim()) continue;
    const [res] = await pool.execute(
      `UPDATE subscriptions
          SET custom_message = ?
        WHERE guild_id = ? AND streamer_id = ?`,
      [text, GUILD_ID, streamerId]
    );
    log(`saying applied  ${username}  (rows=${res.affectedRows})`);
    updated += res.affectedRows;
  }
  return updated;
}

async function pruneNonAllowlistSubsAndAutoTracking(allowedStreamerIds) {
  if (!allowedStreamerIds.length) {
    log('prune: empty allowlist — refusing to delete (would wipe everything)');
    return;
  }
  const placeholders = allowedStreamerIds.map(() => '?').join(',');

  const [delSubs] = await pool.execute(
    `DELETE FROM subscriptions
      WHERE guild_id = ?
        AND streamer_id NOT IN (${placeholders})`,
    [GUILD_ID, ...allowedStreamerIds]
  );
  log(`prune: subscriptions removed = ${delSubs.affectedRows}`);

  const [delLive] = await pool.execute(
    `DELETE FROM live_announcements
      WHERE guild_id = ?
        AND streamer_id NOT IN (${placeholders})`,
    [GUILD_ID, ...allowedStreamerIds]
  );
  log(`prune: live_announcements removed = ${delLive.affectedRows}`);

  const [delAuto] = await pool.execute(
    'DELETE FROM guild_streamer_auto_track WHERE guild_id = ?', [GUILD_ID]
  );
  log(`prune: guild_streamer_auto_track removed = ${delAuto.affectedRows}`);

  const [delTeams] = await pool.execute(
    'DELETE FROM twitch_teams WHERE guild_id = ?', [GUILD_ID]
  );
  log(`prune: twitch_teams removed = ${delTeams.affectedRows}`);

  const [delSched] = await pool.execute(
    'DELETE FROM twitch_schedule_sync_config WHERE guild_id = ?', [GUILD_ID]
  );
  log(`prune: twitch_schedule_sync_config removed = ${delSched.affectedRows}`);
}

async function configureWelcomeAndGoodbye() {
  const message = '🎀 Aloha {user} → welcome to **{server}**! You\'re member #{member_count}. Glide through {rules_channel} and grab your roles in <#' + CHANNELS.selfRole + '>.';
  const goodbyeMessage = '{username} has left the server. We now have {member_count} members.';

  await pool.execute(
    `INSERT INTO welcome_settings
      (guild_id, channel_id, message, welcome_banner_enabled, banner_enabled,
       goodbye_enabled, goodbye_channel_id, goodbye_message,
       card_title_text, card_subtitle_text)
     VALUES (?, ?, ?, 1, 1, 1, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       channel_id = VALUES(channel_id),
       message = VALUES(message),
       welcome_banner_enabled = VALUES(welcome_banner_enabled),
       banner_enabled = VALUES(banner_enabled),
       goodbye_enabled = VALUES(goodbye_enabled),
       goodbye_channel_id = VALUES(goodbye_channel_id),
       goodbye_message = VALUES(goodbye_message),
       card_title_text = VALUES(card_title_text),
       card_subtitle_text = VALUES(card_subtitle_text),
       updated_at = NOW()`,
    [GUILD_ID, CHANNELS.welcome, message, CHANNELS.goodbye, goodbyeMessage, 'Welcome, {user}!', 'You are member #{member_count} of {server}']
  );
  log('welcome_settings: welcome → #welcome, goodbye → #good-bye');
}

async function configureSelfPromo() {
  await pool.execute(
    `INSERT INTO self_promo_config
      (guild_id, enabled, channel_id, allowed_platforms, auto_subscribe, delete_invalid, dm_on_track, dm_on_already_tracked, same_channel)
     VALUES (?, 1, ?, ?, 1, 1, 1, 1, 1)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       channel_id = VALUES(channel_id),
       allowed_platforms = VALUES(allowed_platforms),
       auto_subscribe = VALUES(auto_subscribe),
       delete_invalid = VALUES(delete_invalid),
       dm_on_track = VALUES(dm_on_track),
       updated_at = NOW()`,
    [GUILD_ID, CHANNELS.selfPromo, JSON.stringify(['twitch', 'youtube', 'kick'])]
  );
  log('self_promo_config: enabled → #self-promo');
}

async function configureLeveling() {
  await pool.execute(
    `INSERT INTO level_config (guild_id, enabled, xp_per_message, xp_cooldown_seconds, voice_xp_enabled, level_up_channel_id, level_up_message)
     VALUES (?, 1, 18, 60, 1, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       xp_per_message = VALUES(xp_per_message),
       xp_cooldown_seconds = VALUES(xp_cooldown_seconds),
       voice_xp_enabled = VALUES(voice_xp_enabled),
       level_up_channel_id = VALUES(level_up_channel_id),
       level_up_message = VALUES(level_up_message)`,
    [GUILD_ID, CHANNELS.rankUp, 'GG {user}, you just reached **Level {level}**! 🎀']
  );
  log('level_config: enabled, level-ups → #rank-up');
}

const STAT_VC_DEFS = [
  { key: 'members',  template: '👥 Members: {value}'  },
  { key: 'online',   template: '🟢 Online: {value}'   },
  { key: 'bots',     template: '🤖 Bots: {value}'     },
  { key: 'channels', template: '📺 Channels: {value}' },
];
const STAT_CATEGORY_NAME = '📊 Server Stats';

async function configureStatCounters() {
  const channels = await rest.get(Routes.guildChannels(GUILD_ID));
  let category = channels.find(c => c.type === 4 /* GUILD_CATEGORY */ && c.name === STAT_CATEGORY_NAME);
  if (!category) {
    category = await rest.post(Routes.guildChannels(GUILD_ID), {
      body: {
        name: STAT_CATEGORY_NAME,
        type: 4,
        position: 0,
        permission_overwrites: [
          { id: GUILD_ID, type: 0, deny: '1048576' /* SEND_MESSAGES */, allow: '1024' /* VIEW_CHANNEL */ }
        ]
      }
    });
    log(`stat-counter category created → ${category.id}`);
  } else {
    log(`stat-counter category exists → ${category.id}`);
  }

  for (const def of STAT_VC_DEFS) {
    const placeholderName = def.template.replace('{value}', '...').slice(0, 100);
    let vc = channels.find(c => c.parent_id === category.id && c.type === 2 /* GUILD_VOICE */ && c.name.toLowerCase().includes(def.key.toLowerCase()));
    if (!vc) {
      vc = await rest.post(Routes.guildChannels(GUILD_ID), {
        body: {
          name: placeholderName,
          type: 2,
          parent_id: category.id,
          permission_overwrites: [
            { id: GUILD_ID, type: 0, deny: '1048576' /* CONNECT */, allow: '1024' /* VIEW_CHANNEL */ }
          ]
        }
      });
      log(`stat-counter VC "${def.key}" created → ${vc.id}`);
    } else {
      log(`stat-counter VC "${def.key}" exists → ${vc.id}`);
    }

    await pool.execute(
      `INSERT INTO stat_display_channels (guild_id, channel_id, stat_type, template) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE stat_type = VALUES(stat_type), template = VALUES(template)`,
      [GUILD_ID, vc.id, def.key, def.template]
    );
  }
  log(`stat_display_channels: ${STAT_VC_DEFS.length} rows configured`);
}

async function configureBirthdays() {
  await pool.execute(
    `INSERT INTO birthday_config (guild_id, announcement_channel_id, enabled, message_template, cards_enabled)
     VALUES (?, ?, 1, ?, 1)
     ON DUPLICATE KEY UPDATE
       announcement_channel_id = VALUES(announcement_channel_id),
       enabled = VALUES(enabled),
       message_template = VALUES(message_template),
       cards_enabled = VALUES(cards_enabled)`,
    [GUILD_ID, CHANNELS.general, '🎂 Happy Birthday {user}! Hope your day is amazing 🌸']
  );
  log(`birthday_config: enabled → <#${CHANNELS.general}>`);
}

async function configureFreeGames() {
  const [existing] = await pool.execute(
    'SELECT id FROM free_games_subscriptions WHERE guild_id = ? LIMIT 1', [GUILD_ID]
  );
  if (existing.length) {
    await pool.execute(
      `UPDATE free_games_subscriptions
          SET discord_channel_id = ?, is_enabled = 1,
              notify_free = 1, notify_weekend = 1, notify_dlc = 0, notify_prime = 1, notify_gamepass = 0,
              filter_steam = 1, filter_epic = 1, filter_gog = 1, filter_humble = 1, filter_origin = 0, filter_ubisoft = 0, filter_itch = 1, filter_prime = 1,
              filter_windows = 1, filter_mac = 1, filter_linux = 1, updated_at = NOW()
        WHERE id = ?`,
      [CHANNELS.announcements, existing[0].id]
    );
    log(`free_games_subscriptions: updated → <#${CHANNELS.announcements}>`);
  } else {
    await pool.execute(
      `INSERT INTO free_games_subscriptions
        (guild_id, discord_channel_id, is_enabled, notify_free, notify_weekend, notify_dlc, notify_prime, notify_gamepass,
         filter_steam, filter_epic, filter_gog, filter_humble, filter_origin, filter_ubisoft, filter_itch, filter_prime,
         filter_windows, filter_mac, filter_linux)
       VALUES (?, ?, 1, 1, 1, 0, 1, 0,  1, 1, 1, 1, 0, 0, 1, 1,  1, 1, 1)`,
      [GUILD_ID, CHANNELS.announcements]
    );
    log(`free_games_subscriptions: inserted → <#${CHANNELS.announcements}>`);
  }
}

// ============================================================================
// Phase A — Kitsune REST client (decrypts custom-bot token from `custom_bots`)
// ----------------------------------------------------------------------------
// Discord routes button/select interactions to the bot that AUTHORED the
// message, so panel embeds (music, tickets) MUST be posted with Kitsune's
// token — not the default DISCORD_TOKEN — or the buttons dead-end at the
// default bot in this custom-bot guild.
// ============================================================================
async function loadKitsuneRest() {
  const [rows] = await pool.execute(
    'SELECT bot_token FROM custom_bots WHERE bot_id = ?', [KITSUNE_BOT_ID]
  );
  const row = rows[0];
  if (!row?.bot_token) throw new Error(`Kitsune token row missing for bot_id ${KITSUNE_BOT_ID}`);
  const token = encryption.decrypt(JSON.parse(row.bot_token));
  rest.setToken(token);
  kitsuneRest = rest; // alias; both names point at the same authenticated client
  const me = await kitsuneRest.get(Routes.user('@me'));
  log(`Kitsune REST authenticated as ${me.username} (${me.id})`);
  return me;
}

function avatarUrlFor(me) {
  if (!me?.avatar) return null;
  const ext = me.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.${ext}`;
}

// ============================================================================
// Phase B — Discover-or-create community infrastructure
// ----------------------------------------------------------------------------
// Idempotent: any pre-existing channel/role matching a regex is reused.
// Channels created here are public-by-default unless explicitly given staff
// overwrites (ticket category, ticket-logs, ticket-alerts).
// ============================================================================
async function findOrCreateRole(roles, regex, defaults) {
  const existing = roles.find(r => regex.test(r.name));
  if (existing) {
    log(`role "${existing.name}" exists → ${existing.id}`);
    return { id: existing.id, name: existing.name, created: false };
  }
  const created = await rest.post(Routes.guildRoles(GUILD_ID), { body: defaults });
  log(`role "${defaults.name}" created → ${created.id}`);
  return { id: created.id, name: created.name, created: true };
}

async function findOrCreateChannel(channels, regex, type, body) {
  const existing = channels.find(c => c.type === type && regex.test(c.name));
  if (existing) {
    log(`channel "${existing.name}" (type ${type}) exists → ${existing.id}`);
    return { id: existing.id, name: existing.name, created: false };
  }
  const created = await rest.post(Routes.guildChannels(GUILD_ID), { body });
  log(`channel "${created.name}" (type ${type}) created → ${created.id}`);
  return { id: created.id, name: created.name, created: true };
}

async function ensureCommunityInfrastructure() {
  const roles = await rest.get(Routes.guildRoles(GUILD_ID));
  let channels = await rest.get(Routes.guildChannels(GUILD_ID));

  const staff = await findOrCreateRole(
    roles,
    /^(staff|support|moderators?|mods?|admin)$/i,
    { name: 'Staff', color: 0x5865F2, mentionable: false, hoist: false, permissions: '0' }
  );
  const STAFF_ROLE_ID = staff.id;

  const categoryOverwrites = [
    { id: GUILD_ID,        type: 0, deny:  String(PERM.VIEW_CHANNEL) },
    { id: STAFF_ROLE_ID,   type: 0, allow: String(PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES | PERM.READ_MESSAGE_HISTORY | PERM.MANAGE_MESSAGES) },
    { id: KITSUNE_BOT_ID,  type: 1, allow: String(PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES | PERM.MANAGE_CHANNELS | PERM.MANAGE_MESSAGES | PERM.EMBED_LINKS | PERM.ATTACH_FILES | PERM.READ_MESSAGE_HISTORY) },
  ];

  const ticketsCategory = await findOrCreateChannel(
    channels, /^(?:🎫\s*)?ticket/i, 4 /* GUILD_CATEGORY */,
    { name: '🎫 TICKETS', type: 4, permission_overwrites: categoryOverwrites }
  );
  if (ticketsCategory.created) channels = await rest.get(Routes.guildChannels(GUILD_ID));

  // Panel-button channels stay top-level (or wherever the operator put them).
  // The locked tickets category exists only as the spawn target for opened
  // tickets — channels under it inherit @everyone deny VIEW_CHANNEL.
  const support = await findOrCreateChannel(
    channels, /^(support|general-?support|help)$/i, 0,
    { name: 'support', type: 0, topic: 'Click below to open a general support ticket.' }
  );
  const techSupport = await findOrCreateChannel(
    channels, /^tech-?support$/i, 0,
    { name: 'tech-support', type: 0, topic: 'Click below to open a technical support ticket.' }
  );

  // Private staff-only channels.
  const privateOverwrites = [
    { id: GUILD_ID,       type: 0, deny:  String(PERM.VIEW_CHANNEL) },
    { id: STAFF_ROLE_ID,  type: 0, allow: String(PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES | PERM.READ_MESSAGE_HISTORY) },
    { id: KITSUNE_BOT_ID, type: 1, allow: String(PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES | PERM.EMBED_LINKS | PERM.ATTACH_FILES | PERM.READ_MESSAGE_HISTORY) },
  ];
  const ticketLogs = await findOrCreateChannel(
    channels, /^ticket-?logs?$/i, 0,
    { name: 'ticket-logs', type: 0, parent_id: ticketsCategory.id, topic: 'Closed-ticket transcripts.', permission_overwrites: privateOverwrites }
  );
  const ticketAlerts = await findOrCreateChannel(
    channels, /^ticket-?alerts?$/i, 0,
    { name: 'ticket-alerts', type: 0, parent_id: ticketsCategory.id, topic: 'Alerts when new tickets open.', permission_overwrites: privateOverwrites }
  );

  const music = await findOrCreateChannel(
    channels, /^(music|song-?requests?|music-?bot)$/i, 0,
    { name: 'music', type: 0, topic: 'Music control panel — use the buttons or /music to play tracks.' }
  );
  const suggestions = await findOrCreateChannel(
    channels, /^suggestions?$/i, 0,
    { name: 'suggestions', type: 0, topic: 'Submit ideas via /suggest. Vote on others using the reactions.' }
  );

  return {
    staffRoleId:       STAFF_ROLE_ID,
    ticketsCategoryId: ticketsCategory.id,
    supportId:         support.id,
    techSupportId:     techSupport.id,
    ticketLogsId:      ticketLogs.id,
    ticketAlertsId:    ticketAlerts.id,
    musicId:           music.id,
    suggestionsId:     suggestions.id,
  };
}

// ============================================================================
// Phase C — Suggestions config (DB-only)
// ============================================================================
async function configureSuggestions(suggestionsChannelId) {
  await pool.execute(
    `INSERT INTO suggestion_config
       (guild_id, suggestions_channel_id, enabled, allow_anonymous, require_approval)
     VALUES (?, ?, 1, 0, 0)
     ON DUPLICATE KEY UPDATE
       suggestions_channel_id = VALUES(suggestions_channel_id),
       enabled                = 1,
       require_approval       = 0`,
    [GUILD_ID, suggestionsChannelId]
  );
  log(`suggestion_config: enabled, direct-post → <#${suggestionsChannelId}>`);
}

// ============================================================================
// Phase D — Auto-publisher (DB-only). Crossposts every GuildAnnouncement
// channel in the guild via core/auto-publisher.js + events/messageCreate.js.
// ============================================================================
async function configureAutoPublisher() {
  await pool.execute(
    `INSERT INTO auto_publisher_config (guild_id, is_enabled)
     VALUES (?, 1)
     ON DUPLICATE KEY UPDATE is_enabled = 1`,
    [GUILD_ID]
  );
  log('auto_publisher_config: enabled (crossposts all NEWS channels)');
}

// ============================================================================
// Phase E — Music panel (Kitsune posts the embed; idempotent)
// ============================================================================
async function configureMusicPanel(musicChannelId, kitsuneAvatarUrl) {
  const [existingRows] = await pool.execute(
    'SELECT channel_id, message_id FROM music_panels WHERE guild_id = ?', [GUILD_ID]
  );
  if (existingRows.length) {
    const ex = existingRows[0];
    try {
      await kitsuneRest.get(Routes.channelMessage(ex.channel_id, ex.message_id));
      log(`music_panels: existing message ${ex.message_id} in <#${ex.channel_id}> — skipping`);
      return;
    } catch (_) {
      log(`music_panels: stored message ${ex.message_id} is gone — reposting`);
    }
  }

  const embed = {
    color: 0x2B2D31,
    author: { name: 'Live Music Player' },
    title: 'The queue is empty',
    description: 'Add a song using the dropdown menu below to get started.',
    ...(kitsuneAvatarUrl ? { thumbnail: { url: kitsuneAvatarUrl } } : {}),
    footer: { text: 'Use the controls below to manage the music.' },
  };
  const playbackRow = {
    type: 1,
    components: [
      { type: 2, custom_id: 'music-play-pause', style: 1 /* Primary   */, emoji: { name: '⏸️' }, disabled: true },
      { type: 2, custom_id: 'music-skip',       style: 2 /* Secondary */, emoji: { name: '⏭️' }, disabled: true },
      { type: 2, custom_id: 'music-stop',       style: 4 /* Danger    */, emoji: { name: '⏹️' }, disabled: true },
      { type: 2, custom_id: 'music-clear',      style: 2 /* Secondary */, emoji: { name: '🗑️' }, disabled: true },
    ],
  };
  const selectRow = {
    type: 1,
    components: [{
      type: 3 /* STRING_SELECT */,
      custom_id: 'music-add-song',
      placeholder: 'Add a song or start a DJ',
      options: [
        { label: 'Add song/playlist by name or URL', description: 'Add a song, YouTube playlist, or Spotify playlist', value: 'add_song_modal' },
        { label: 'Start an AI DJ session',           description: 'AI-generated playlist or play from a playlist link',  value: 'start_dj_modal' },
      ],
    }],
  };

  const msg = await kitsuneRest.post(Routes.channelMessages(musicChannelId), {
    body: { embeds: [embed], components: [playbackRow, selectRow] },
  });
  await pool.execute(
    `INSERT INTO music_panels (guild_id, channel_id, message_id) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), message_id = VALUES(message_id)`,
    [GUILD_ID, musicChannelId, msg.id]
  );
  log(`music_panels: posted → message ${msg.id} in <#${musicChannelId}>`);
}

// ============================================================================
// Phase F — Ticket panels ×2 (General Support + Tech Support)
// ============================================================================
async function configureTicketPanels(infra) {
  const panels = [
    {
      panel_name: 'General Support',
      channel_id: infra.supportId,
      embed_title: '🎫 Support',
      embed_description: 'Need help? Click below to open a support ticket.',
      embed_color: '#5865F2',
      button_text: 'Open Support Ticket',
      button_emoji: '🎫',
      button_style: 1, // Primary
    },
    {
      panel_name: 'Tech Support',
      channel_id: infra.techSupportId,
      embed_title: '🔧 Tech Support',
      embed_description: 'Having a technical issue? Click below for help.',
      embed_color: '#FF8C00',
      button_text: 'Open Tech Ticket',
      button_emoji: '🔧',
      button_style: 2, // Secondary
    },
  ];

  for (const p of panels) {
    const [existingRows] = await pool.execute(
      'SELECT panel_id, panel_message_id, panel_channel_id FROM ticket_panels WHERE guild_id = ? AND panel_name = ? LIMIT 1',
      [GUILD_ID, p.panel_name]
    );

    let panelId;
    let messageStillAlive = false;
    if (existingRows.length) {
      panelId = existingRows[0].panel_id;
      await pool.execute(
        `UPDATE ticket_panels SET
            panel_channel_id    = ?,
            embed_title         = ?,
            embed_description   = ?,
            embed_color         = ?,
            button_text         = ?,
            button_emoji        = ?,
            ticket_category_id  = ?,
            support_role_id     = ?,
            save_transcripts    = 1,
            log_channel_id      = ?,
            alert_channel_id    = ?,
            is_active           = 1
         WHERE panel_id = ?`,
        [p.channel_id, p.embed_title, p.embed_description, p.embed_color,
         p.button_text, p.button_emoji, infra.ticketsCategoryId, infra.staffRoleId,
         infra.ticketLogsId, infra.ticketAlertsId, panelId]
      );

      if (existingRows[0].panel_message_id && existingRows[0].panel_channel_id === p.channel_id) {
        try {
          await kitsuneRest.get(Routes.channelMessage(p.channel_id, existingRows[0].panel_message_id));
          messageStillAlive = true;
        } catch (_) { /* missing — will repost */ }
      }
    } else {
      const [ins] = await pool.execute(
        `INSERT INTO ticket_panels
           (guild_id, panel_name, panel_channel_id, embed_title, embed_description, embed_color,
            button_text, button_emoji, ticket_category_id, support_role_id, save_transcripts,
            log_channel_id, alert_channel_id, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`,
        [GUILD_ID, p.panel_name, p.channel_id, p.embed_title, p.embed_description, p.embed_color,
         p.button_text, p.button_emoji, infra.ticketsCategoryId, infra.staffRoleId,
         infra.ticketLogsId, infra.ticketAlertsId]
      );
      panelId = ins.insertId;
    }

    if (messageStillAlive) {
      log(`ticket_panels: "${p.panel_name}" message alive — skipping repost`);
      continue;
    }

    const embed = {
      color: parseInt(p.embed_color.slice(1), 16),
      title: p.embed_title,
      description: p.embed_description,
    };
    const buttonRow = {
      type: 1,
      components: [{
        type: 2,
        custom_id: `ticket_create_${panelId}`,
        style: p.button_style,
        label: p.button_text,
        emoji: { name: p.button_emoji },
      }],
    };

    const msg = await kitsuneRest.post(Routes.channelMessages(p.channel_id), {
      body: { embeds: [embed], components: [buttonRow] },
    });
    await pool.execute(
      'UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?', [msg.id, panelId]
    );
    log(`ticket_panels: "${p.panel_name}" posted → message ${msg.id} in <#${p.channel_id}>`);
  }
}

async function verify(roleIds, panel) {
  console.log('\n=== VERIFICATION ===');
  const [counts] = await pool.execute(`
    SELECT 'subscriptions' AS f, COUNT(*) AS c FROM subscriptions WHERE guild_id = ?
    UNION ALL SELECT 'subs_with_ping', COUNT(*) FROM subscriptions WHERE guild_id = ? AND ping_role_id IS NOT NULL
    UNION ALL SELECT 'reaction_panels', COUNT(*) FROM reaction_role_panels WHERE guild_id = ?
    UNION ALL SELECT 'reaction_mappings', (SELECT COUNT(*) FROM reaction_role_mappings rm JOIN reaction_role_panels rp ON rm.panel_id = rp.id WHERE rp.guild_id = ?)
    UNION ALL SELECT 'welcome_settings', COUNT(*) FROM welcome_settings WHERE guild_id = ?
    UNION ALL SELECT 'self_promo_config', COUNT(*) FROM self_promo_config WHERE guild_id = ?
    UNION ALL SELECT 'level_config', COUNT(*) FROM level_config WHERE guild_id = ?
  `, [GUILD_ID, GUILD_ID, GUILD_ID, GUILD_ID, GUILD_ID, GUILD_ID, GUILD_ID]);
  for (const r of counts) console.log(`  ${r.f.padEnd(20)} ${r.c}`);

  console.log('\n=== Stream Notification roles ===');
  for (const k of Object.keys(roleIds)) console.log(`  ${k.padEnd(10)} ${roleIds[k]}`);

  console.log('\n=== Panel ===');
  console.log(`  panel #${panel.panelId} → message ${panel.messageId} in <#${CHANNELS.selfRole}>`);

  const [statCounts] = await pool.execute('SELECT COUNT(*) AS c FROM stat_display_channels WHERE guild_id = ?', [GUILD_ID]);
  const [bday] = await pool.execute('SELECT COUNT(*) AS c FROM birthday_config WHERE guild_id = ?', [GUILD_ID]);
  const [fg] = await pool.execute('SELECT COUNT(*) AS c FROM free_games_subscriptions WHERE guild_id = ?', [GUILD_ID]);
  console.log(`  ${'stat_display_channels'.padEnd(20)} ${statCounts[0].c}`);
  console.log(`  ${'birthday_config'.padEnd(20)} ${bday[0].c}`);
  console.log(`  ${'free_games_subs'.padEnd(20)} ${fg[0].c}`);

  // Community feature parity (extension)
  const [music]   = await pool.execute('SELECT COUNT(*) AS c FROM music_panels         WHERE guild_id = ?',                            [GUILD_ID]);
  const [tickets] = await pool.execute('SELECT COUNT(*) AS c FROM ticket_panels        WHERE guild_id = ? AND is_active = 1',          [GUILD_ID]);
  const [sugg]    = await pool.execute('SELECT COUNT(*) AS c FROM suggestion_config    WHERE guild_id = ? AND enabled = 1',            [GUILD_ID]);
  const [pub]     = await pool.execute('SELECT COUNT(*) AS c FROM auto_publisher_config WHERE guild_id = ? AND is_enabled = 1',         [GUILD_ID]);
  console.log(`  ${'music_panels'.padEnd(20)} ${music[0].c}      (expected 1)`);
  console.log(`  ${'ticket_panels'.padEnd(20)} ${tickets[0].c}      (expected 2)`);
  console.log(`  ${'suggestion_config'.padEnd(20)} ${sugg[0].c}      (expected 1)`);
  console.log(`  ${'auto_publisher'.padEnd(20)} ${pub[0].c}      (expected 1)`);

  // Roster lockdown verification
  console.log('\n=== Stream roster lockdown ===');
  const [lockdown] = await pool.execute(`
    SELECT 'subs_total'           AS f, (SELECT COUNT(*) FROM subscriptions               WHERE guild_id = ?) AS c
    UNION ALL SELECT 'subs_with_saying', (SELECT COUNT(*) FROM subscriptions               WHERE guild_id = ? AND custom_message IS NOT NULL)
    UNION ALL SELECT 'auto_track',       (SELECT COUNT(*) FROM guild_streamer_auto_track  WHERE guild_id = ?)
    UNION ALL SELECT 'twitch_teams',     (SELECT COUNT(*) FROM twitch_teams               WHERE guild_id = ?)
    UNION ALL SELECT 'schedule_syncs',   (SELECT COUNT(*) FROM twitch_schedule_sync_config WHERE guild_id = ?)
  `, [GUILD_ID, GUILD_ID, GUILD_ID, GUILD_ID, GUILD_ID]);
  const expected = { subs_total: 14, auto_track: 0, twitch_teams: 0, schedule_syncs: 0 };
  for (const r of lockdown) {
    const exp = expected[r.f];
    const tag = exp === undefined ? '' : (r.c == exp ? '  ✓' : `  ✗ (expected ${exp})`);
    console.log(`  ${r.f.padEnd(18)} ${r.c}${tag}`);
  }

  const [roster] = await pool.execute(`
    SELECT st.username, st.platform, s.announcement_channel_id,
           (s.custom_message IS NOT NULL) AS has_saying
      FROM subscriptions s
      JOIN streamers st ON st.streamer_id = s.streamer_id
     WHERE s.guild_id = ?
     ORDER BY FIELD(LOWER(st.username),
       'forsaken_ichigo','forsakenpnay','blue_collar_mike',
       'redrum_615','xbatmangoddessx','shinobijedji13','anathebananagg',
       'wolfzgangz','mamabear_xal','drag0n190','hibinforsaken','fall3nking','forsakendarkwolf','karlogeetv'
     )
  `, [GUILD_ID]);
  console.log('\n=== Active roster ===');
  for (const r of roster) {
    console.log(`  ${r.username.padEnd(22)} ${r.platform.padEnd(7)} chan=${r.announcement_channel_id}  saying=${r.has_saying ? 'yes' : 'no'}`);
  }

  console.log('\n--- next steps ---');
  console.log('  • Either restart PM2 or wait ~60s for manager TTL caches to refresh.');
  console.log('  • Smoke test: have a test alt click each button in #self-role; verify role added/removed.');
  console.log('  • Cutover: only after a streamer goes live and CertiFried\'s announcement pings the matching opt-in role can NotifyMe + StreamCord be safely kicked.');
  console.log('  • JTC config NOT applied yet — run this AFTER kicking VoiceMaster so both bots don\'t race the trigger channel:');
  console.log(`      INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template) VALUES ('${GUILD_ID}', '${CHANNELS.jtcTrigger}', '${CHANNELS.jtcCategory}', '{user}\\'s Room') ON DUPLICATE KEY UPDATE creator_channel_id = VALUES(creator_channel_id), category_id = VALUES(category_id), naming_template = VALUES(naming_template);`);
}

(async () => {
  log(`Forsaken Warriors feature setup — guild ${GUILD_ID}`);

  // Default bot is not in this guild — authenticate as Kitsune up front so
  // every Discord call (channel/role CRUD, panel posts) routes correctly.
  const me = await loadKitsuneRest();
  const kitsuneAvatarUrl = avatarUrlFor(me);

  log('preflight: confirming bot can hit the guild...');
  const guild = await rest.get(Routes.guild(GUILD_ID));
  log(`✓ guild "${guild.name}" reachable`);

  const roleIds = await ensureStreamRoles();
  const panel = await ensureStreamPanel(roleIds);
  const subs = await configureSubscriptions(roleIds);
  log(`subscriptions touched: ${subs}`);

  // Lock the roster: hard-delete drift, close auto-track entrypoints, then
  // recover personal founder sayings from old Streamcord posts in #founders-strm.
  const streamerIdByUsername = await loadAllowlistStreamerIds();
  const allowlistIds = [...streamerIdByUsername.values()];
  await pruneNonAllowlistSubsAndAutoTracking(allowlistIds);

  const founderUsernames = STREAMER_ROUTES
    .filter(r => r.tier === 'founders')
    .map(r => r.username);
  const sayings = await scrapeFounderSayings(founderUsernames);
  await applyFounderSayings(sayings, streamerIdByUsername);

  await configureWelcomeAndGoodbye();
  await configureSelfPromo();
  await configureLeveling();
  await configureStatCounters();
  await configureBirthdays();
  await configureFreeGames();

  // ── Community feature parity (music / tickets / suggestions / auto-publisher)
  const infra = await ensureCommunityInfrastructure();
  await configureSuggestions(infra.suggestionsId);
  await configureAutoPublisher();
  await configureMusicPanel(infra.musicId, kitsuneAvatarUrl);
  await configureTicketPanels(infra);

  await verify(roleIds, panel);

  log('done.');
  await pool.end();
})().catch(async e => {
  console.error('FAIL', e.stack || e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
