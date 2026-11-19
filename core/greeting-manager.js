import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import { recordBotMessage } from './bot-messages.js';
import logger from '../utils/logger.js';
import { safeJsonArray } from '../utils/safeJson.js';
import { accessibleAttachment, welcomeCardAltText } from '../utils/accessible-attachment.js';
import { displayNameFor } from '../utils/display-name.js';
import { drawableText } from '../utils/drawable-text.js';
import {
  roundedRectPath, paintBackground, paintAvatar, paintOrnament,
} from '../utils/welcome-card-art.js';
import { paletteOf, drawFromBag } from '../utils/welcome-card-palettes.js';
import { readableName } from '../utils/channel-name-style.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { renderTemplate } from './template-resolver.js';
import { assignAutoroles as giveAutoroles } from './autoroles.js';

// Discord's limits for a message body and an embed description.
const clip = (text, max) => {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** '#rrggbb' from the dashboard, as a number for an embed; null when unset or malformed. */
function embedColor(value) {
  const m = String(value || '').trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? parseInt(m[1], 16) : null;
}

/** 'text' or 'embed'. Rows saved before the style choice existed keep what they did: an embed with the banner, text without. */
export function welcomeStyle(config) {
  const t = String(config?.message_type || '').toLowerCase();
  if (t === 'text' || t === 'embed') return t;
  return config?.banner_enabled ? 'embed' : 'text';
}

const DEFAULT_DM = 'Welcome to {server}, {user.display}!';
const DEFAULT_GOODBYE = '**{user}** left the server.';
const DEFAULT_BAN = '**{user}** was banned from {server}.';

/**
 * The welcome DM (welcome_settings.dm_welcome_enabled / dm_welcome_message). Plain text, sent before
 * the channel post and whether or not a welcome channel is set. Members who do not accept DMs from
 * server members are skipped quietly — that is their setting, not a fault.
 */
async function sendWelcomeDm(member, config) {
  const text = clip(renderTemplate(config.dm_welcome_message || DEFAULT_DM, {
    member,
    guild: member.guild,
    legacyUser: 'tag',
  }), 2000).trim();
  if (!text) return;
  try {
    await member.send({ content: text, allowedMentions: { parse: [] } });
    logger.info(`[GreetingManager] Sent the welcome DM to ${member.user.tag}`, { guildId: member.guild.id, category: 'greeting' });
  } catch (error) {
    if (error.code === 50007) {
      logger.debug(`[GreetingManager] ${member.user.tag} does not accept DMs; welcome DM skipped`, { guildId: member.guild.id });
    } else {
      logger.warn(`[GreetingManager] Welcome DM to ${member.user.tag} failed: ${error.message}`, { guildId: member.guild.id, category: 'greeting' });
    }
  }
}

// Discord-style random quirky join phrases. {user} is replaced with the member mention.
const QUIRKY_JOINS = [
  "{user} just showed up!",
  "Everyone welcome {user}!",
  "A wild {user} appeared!",
  "{user} just slid into the server.",
  "Look who it is — {user}!",
  "{user} hopped in. Say hi!",
  "Roll out the carpet, {user} has arrived.",
  "{user} just joined the party. 🎉",
  "Glad you could make it, {user}.",
  "Welcome aboard, {user}.",
  "{user} landed. Brace for awesome.",
  "{user} has entered the chat.",
  "It's dangerous to go alone — take {user}!",
  "{user} just logged on.",
  "{user}, welcome to the pack.",
  "A new friend joined: {user}.",
  "{user} just materialized out of thin air.",
  "{user} rolled a 20 on initiative and joined.",
  "Please give a warm welcome to {user}.",
  "{user} is here. The server is now cooler.",
];

function pickQuirky() {
  return QUIRKY_JOINS[Math.floor(Math.random() * QUIRKY_JOINS.length)];
}

/**
 * Which card design this member gets.
 *
 * 'fixed' means the guild chose one palette and every join uses it. 'shuffle' deals
 * from a persisted bag: each design appears once before any repeats, and a fresh bag
 * never opens with the design that closed the last one, so no two consecutive members
 * see the same card.
 *
 * The bag is stored rather than kept in memory — a restart between two joins would
 * otherwise reset it, and in a quiet server that shows up as the same card twice.
 */
async function resolvePalette(guildId, config) {
  const rotating = String(config.card_rotation || 'fixed').toLowerCase() === 'shuffle';

  let keys = [];
  try {
    keys = safeJsonArray(config.card_pool) || [];
  } catch (e) {
    keys = [];
  }

  // paletteOf() falls back to the first palette when the key is missing or unknown.
  if (!rotating || keys.length < 2) return paletteOf(keys[0]);

  let remaining = [];
  let lastKey = null;
  try {
    const [rows] = await pool.execute(
      'SELECT remaining, last_key FROM welcome_card_bag WHERE guild_id = ?',
      [guildId]
    );
    if (rows.length) {
      remaining = safeJsonArray(rows[0].remaining) || [];
      lastKey = rows[0].last_key;
    }
  } catch (e) {
    logger.warn(`[GreetingManager] Could not read the card bag, falling back to the first design: ${e.message}`, {
      guildId, category: 'greeting'
    });
    return paletteOf(keys[0]);
  }

  const draw = drawFromBag(keys, remaining, lastKey);

  try {
    await pool.execute(
      `INSERT INTO welcome_card_bag (guild_id, remaining, last_key) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE remaining = VALUES(remaining), last_key = VALUES(last_key)`,
      [guildId, JSON.stringify(draw.remaining), draw.key]
    );
  } catch (e) {
    // The card still renders — the next join just re-deals from the stored state.
    logger.warn(`[GreetingManager] Could not persist the card bag: ${e.message}`, {
      guildId, category: 'greeting'
    });
  }

  return paletteOf(draw.key);
}

// {choice:a|b|c} picks one branch, {random:1-100} picks a number. Rolled per
// join, so a guild gets varied wording from a single stored message instead of
// the same sentence every time. Same syntax as core/template-resolver.js.
function expandDynamic(text) {
  return String(text)
    .replace(/\{random:(-?\d+)-(-?\d+)\}/g, (match, lo, hi) => {
      const a = Number(lo), b = Number(hi);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return match;
      const min = Math.min(a, b), max = Math.max(a, b);
      return String(min + Math.floor(Math.random() * (max - min + 1)));
    })
    .replace(/\{choice:([^}]*)\}/g, (match, list) => {
      const options = list.split('|');
      return options.length ? options[Math.floor(Math.random() * options.length)] : match;
    });
}

let Canvas;
try {
  Canvas = await import('canvas');
} catch (e) {
  logger.warn('Canvas module not available. Banner generation will be disabled.', { category: 'greeting' });
}

import { enforceSizeLimit } from '../utils/cacheUtils.js';

// Deduplication cache to prevent duplicate welcome messages
// Key: `${guildId}-${memberId}`, Value: timestamp
const recentWelcomes = new Map();
const WELCOME_DEDUP_WINDOW = 10000; // 10 seconds
const MAX_WELCOME_CACHE = 5000; // Prevent unbounded growth

// Clean up old entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of recentWelcomes) {
    if (now - timestamp > WELCOME_DEDUP_WINDOW) {
      recentWelcomes.delete(key);
    }
  }
  // Enforce max size to prevent memory leaks
  enforceSizeLimit(recentWelcomes, MAX_WELCOME_CACHE, 'recentWelcomes');
}, 60000);

/**
 * Handle when a member joins a guild
 * @param {import('discord.js').GuildMember} member - The member who joined
 */
export async function handleGuildMemberAdd(member) {
  // Bots get no greeting — only the bot autoroles, when the server has chosen some
  // (core/autoroles.js). events/guildMemberAdd.js has already dropped replayed joins.
  if (member.user?.bot) {
    await assignAutoroles(member);
    return;
  }

  const guildId = member.guild.id;
  const memberId = member.id;
  const botIdentifier = member.client.isDefaultBot ? 'DEFAULT BOT' : `CUSTOM BOT (${member.client.botId})`;

  logger.info(`[GreetingManager] ${botIdentifier} handleGuildMemberAdd called for ${member.user.tag} in guild ${guildId}`);

  // Stale join check - if member joined more than 30 seconds ago, this is likely
  // a replayed event from a bot restart, not a real join
  if (member.joinedAt) {
    const joinAge = Date.now() - member.joinedAt.getTime();
    if (joinAge > 30000) {
      logger.info(`[GreetingManager] Skipping welcome for ${member.user.tag} in ${guildId} - member joined ${Math.round(joinAge / 1000)}s ago (stale event)`, { guildId, memberId, botIdentifier, category: 'greeting' });
      return;
    }
  }

  // Deduplication check - prevent duplicate welcome messages within 10 seconds
  // Uses atomic check-and-set pattern to prevent race conditions
  const dedupKey = `${guildId}-${memberId}`;
  const now = Date.now();
  const lastWelcome = recentWelcomes.get(dedupKey);

  // Atomically check and set to prevent race condition
  if (lastWelcome && now - lastWelcome < WELCOME_DEDUP_WINDOW) {
    logger.warn(`[GreetingManager] Duplicate welcome prevented for ${member.user.tag} in guild ${guildId} (${now - lastWelcome}ms since last)`, {
      guildId,
      memberId,
      botIdentifier,
      category: 'greeting'
    });
    return;
  }

  // Set immediately before any async operations to prevent race condition
  recentWelcomes.set(dedupKey, now);

  try {
    const [rows] = await pool.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [guildId]);

    if (rows.length === 0) {
      logger.debug(`[GreetingManager] No welcome settings for guild ${guildId}`);
      return;
    }

    const config = rows[0];

    // The DM does not depend on a welcome channel being set.
    if (Number(config.dm_welcome_enabled)) await sendWelcomeDm(member, config);

    if (!config.channel_id) {
      logger.debug(`[GreetingManager] No welcome channel for guild ${guildId}`);
      return;
    }
    const channel = member.guild.channels.cache.get(config.channel_id);
    if (!channel) {
      logger.warn(`[GreetingManager] Welcome channel ${config.channel_id} not found in guild ${guildId}`);
      return;
    }

    logger.info(`[GreetingManager] ${botIdentifier} preparing to send welcome message to channel ${config.channel_id}`);

    const post = await renderWelcomePost(member, config);
    const what = post.banner ? 'enhanced welcome banner' : 'welcome message';
    logger.info(`[GreetingManager] ${botIdentifier} SENDING ${what} for ${member.user.tag} to channel ${config.channel_id}`);
    const _sent = await channel.send(post.payload);
    recordBotMessage({ guildId: member.guild?.id, channelId: channel.id, messageId: _sent?.id, templateKey: 'welcome.joined', feature: 'welcome' });
    logger.info(`[GreetingManager] ${botIdentifier} SENT ${what} for ${member.user.tag}.`, {
      guildId,
      category: 'greeting'
    });

  } catch (error) {
    logger.error('Error handling guild member add.', {
      guildId,
      category: 'greeting',
      error: error.stack
    });
  } finally {
    // Autoroles don't depend on the welcome message: give them even when this server has no welcome
    // channel set up, the channel is gone, or the send failed (each of those returns/throws above).
    // Stale replays and duplicate joins never get here — they return before the try.
    try {
      await assignAutoroles(member);
    } catch (error) {
      logger.error('[GreetingManager] Autorole assignment failed', { guildId, memberId, error: error.message });
    }
  }
}

/**
 * The welcome post for a member, exactly as the join handler sends it: the text, and with the banner
 * on, the card (title, subtitle, background, light or dark style) in an embed or under the text.
 * `/manage welcome test` shows the same thing (register H-665: it used to draw an older card of its
 * own). `preview` keeps a shuffled card design from using up a turn in the server's rotation.
 *
 * @returns {Promise<{ payload: object, banner: boolean, style: 'text'|'embed' }>}
 */
export async function renderWelcomePost(member, config, { preview = false } = {}) {
  const guildId = member.guild.id;
  const style = welcomeStyle(config);
  {
    // Pre-compute a random quirky phrase once per join so it stays consistent across
    // message body, embed title, and card title if all three reference it.
    const quirkyPhrase = pickQuirky()
      .replace(/{user}/g, `<@${member.id}>`);
    const quirkyPlain = QUIRKY_JOINS[Math.floor(Math.random() * QUIRKY_JOINS.length)]
      .replace(/{user}/g, displayNameFor(member));

    // Delegate placeholder substitution to the shared resolver so dotted-path
    // forms like {user.mention} and {server.name} work the same way they do in
    // custom commands. legacyUser:'tag' preserves historical welcome semantics
    // where a bare {user} rendered as the user tag, not a mention — the
    // resolver also handles {choice:…} and {random:…} internally.
    let messageContent = renderTemplate(config.message || `Welcome ${member}!`, {
      member,
      guild: member.guild,
      legacyUser: 'tag',
      extra: {
        quirky: quirkyPhrase,
        quirky_plain: quirkyPlain,
      },
    });

    /* The card repeats the greeting under the member's name. Expanding
       {choice:…} a second time for the card would pick a DIFFERENT line from the
       pool, so the message and the picture would disagree. Capture what was
       actually chosen and let the card ask for it by name with {greeting}. */
    const chosenGreeting = messageContent
      .replace(new RegExp(`<@!?${member.id}>`, 'g'), '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (config.banner_enabled && Canvas) {
      const width = 1100;
      const height = 400;
      const padding = 40;
      const canvas = Canvas.createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      // 'light' is for pastel servers: no scrim, avatar on the left, dark ink.
      // Anything else keeps the original dark card exactly as it was.
      const light = String(config.card_style || 'dark').toLowerCase() === 'light';

      // Which design this member gets. 'fixed' keeps whatever single palette the
      // guild set; 'shuffle' deals from a bag so consecutive joins never match.
      // A preview shows the first design of the pool and leaves the stored bag alone.
      const palette = !light ? null
        : preview ? paletteOf((safeJsonArray(config.card_pool) || [])[0])
        : await resolvePalette(guildId, config);

      // Background — custom image, or a plain card with rounded corners
      const backgroundUrl = config.card_background_url || config.banner_background_url;
      /* A deeper radius on the light card. The old 30 on an 1100x400 slab still
         read as a rectangle with the corners filed off; the owner's word was
         "blocky". The dark card keeps what it had. */
      const radius = light ? 52 : 30;

      const drawRoundedRect = (x, y, w, h, r) => roundedRectPath(ctx, x, y, w, h, r);

      // No background image configured, or it failed to load.
      const fillCardBackground = () => {
        drawRoundedRect(0, 0, width, height, radius);
        if (light) {
          /* Gradient, then soft blooms and a pair of long arcs. The arcs run off
             both edges so the eye follows a curve across the card instead of
             stopping dead in the corners. */
          ctx.save();
          ctx.clip();
          paintBackground(ctx, width, height, palette);
          ctx.restore();
        } else {
          ctx.fillStyle = '#000000';
          ctx.fill();
        }
      };

      if (backgroundUrl) {
        try {
          const background = await Canvas.loadImage(backgroundUrl);
          drawRoundedRect(0, 0, width, height, radius);
          ctx.clip();
          ctx.drawImage(background, 0, 0, width, height);
          // The scrim exists to keep white text legible over an arbitrary photo.
          // A light card sets its text in dark ink, so dimming the artwork would
          // only muddy the thing the owner chose.
          if (!light) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.fillRect(0, 0, width, height);
          }
        } catch (e) {
          logger.error('Failed to load welcome card background.', {
            guildId, category: 'greeting', error: e.message
          });
          fillCardBackground();
        }
      } else {
        fillCardBackground();
      }

      // Circular avatar with white border. Dark: centred up top, text beneath.
      // Light: on the left with the text beside it, which is how the owner's
      // own mock-up reads and leaves room for a longer greeting line.
      const avatarSize = light ? 168 : 180;
      const avatarCenterX = light ? padding + 24 + avatarSize / 2 : width / 2;
      const avatarCenterY = light ? height / 2 : padding + avatarSize / 2 + 10;

      // Drawn before the avatar so the rings sit behind it, not over the face.
      if (light) paintOrnament(ctx, width, height, palette);

      let avatarImage = null;
      try {
        const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
        avatarImage = await Canvas.loadImage(avatarUrl);
      } catch (err) {
        logger.error(`Failed to load avatar for ${member.user.tag}:`, {
          error: err.message, category: 'greeting'
        });
      }

      if (light) {
        paintAvatar(ctx, avatarImage, avatarCenterX, avatarCenterY, avatarSize, palette);
      } else if (avatarImage) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatarImage, avatarCenterX - avatarSize / 2, avatarCenterY - avatarSize / 2, avatarSize, avatarSize);
        ctx.restore();

        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(avatarCenterX, avatarCenterY, avatarSize / 2 + 2, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.stroke();
      }

      const memberCount = member.guild.memberCount;
      /* "our 22th" is what a bare {memberCount} plus a hard-coded suffix gives
         you. Ordinals are cheap to get right and the card says it out loud. */
      const ordinal = (n) => {
        const r100 = n % 100, r10 = n % 10;
        if (r100 >= 11 && r100 <= 13) return `${n}th`;
        return `${n}${r10 === 1 ? 'st' : r10 === 2 ? 'nd' : r10 === 3 ? 'rd' : 'th'}`;
      };
      const fill = (t) => expandDynamic(t)
        .replace(/{greeting}/g, chosenGreeting)
        // Strip undrawable glyphs from the name here, not just at fillText: "Gamer ꨄ"
        // would otherwise leave "Welcome, Gamer !" with a stranded space.
        .replace(/{user}/g, drawableText(displayNameFor(member)).trim())
        .replace(/{server}/g, member.guild.name)
        .replace(/{memberOrdinal}/g, ordinal(memberCount))
        .replace(/{memberCount}/g, memberCount.toString());

      let titleText;
      let subtitleText;

      if (light) {
        // Three rows beside the avatar: a small uppercase eyebrow, the member's
        // own name, then the greeting line. The name is always the member's —
        // it is the one thing on the card that must never be templated away.
        const textX = avatarCenterX + avatarSize / 2 + 40;
        /* Stop the text short of the ornament rather than running under it. */
        const maxTextWidth = width * 0.66 - textX;
        titleText = fill(config.card_title_text || 'Welcome in!');
        subtitleText = fill(config.card_subtitle_text || "so happy you're here!");

        ctx.textAlign = 'left';

        ctx.fillStyle = palette.eyebrow;
        ctx.font = 'bold 21px Lato, DejaVu Sans, sans-serif';
        ctx.fillText(drawableText(titleText.toUpperCase()), textX, height / 2 - 52);

        ctx.fillStyle = palette.ink;
        ctx.font = 'bold 46px Lato, DejaVu Sans, sans-serif';
        /* A name carrying a glyph no installed font has draws a hex box — a real
           member called "JosClaps ꨄ" got one. Drop what cannot be drawn. */
        ctx.fillText(drawableText(displayNameFor(member)), textX, height / 2 + 4);
        // node-canvas has no colour-emoji face, so the accent glyph would render
        // as a tofu box. The palette's emoji stays in the message text, where
        // Discord draws it properly, and never on the canvas.

        ctx.fillStyle = palette.body;
        ctx.font = '25px Lato, DejaVu Sans, sans-serif';
        // A rotated line can be long. Wrap to two rows rather than run off the card.
        const words = subtitleText.split(' ');
        let line = '';
        const rows = [];
        for (const w of words) {
          const test = line ? `${line} ${w}` : w;
          if (ctx.measureText(test).width > maxTextWidth && line) { rows.push(line); line = w; }
          else line = test;
          if (rows.length === 2) break;
        }
        if (line && rows.length < 2) rows.push(line);
        rows.forEach((r, i) => ctx.fillText(drawableText(r), textX, height / 2 + 48 + i * 32));
      } else {
        // Title text — "{username} just joined the server"
        const textY = avatarCenterY + avatarSize / 2 + 45;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#FFFFFF';
        titleText = fill(config.card_title_text || '{user} just joined the server');
        /* Owner-written text can run longer than the stock line ever did; shrink
           rather than let it run off both edges of the card. */
        const fitted = (text, size) => {
          ctx.font = `${size}px Arial`;
          while (size > 16 && ctx.measureText(text).width > width - padding * 2) ctx.font = `${--size}px Arial`;
          return text;
        };
        ctx.fillText(fitted(drawableText(titleText), 42), width / 2, textY);

        // Subtitle — "Member #N"
        ctx.fillStyle = '#DCDDDE';
        subtitleText = fill(config.card_subtitle_text || 'Member #{memberCount}');
        ctx.fillText(fitted(drawableText(subtitleText), 24), width / 2, textY + 35);
      }

      // The card renders the member's name, avatar and join position as pixels.
      // Without alt text a screen-reader user gets the embed title and nothing
      // else, so restate the card's own text (title + subtitle) rather than
      // describing it as "a welcome image".
      const attachment = accessibleAttachment(canvas.toBuffer(), {
        name: 'welcome-image.png',
        description: `${titleText} — ${subtitleText}. ${welcomeCardAltText({
          username: displayNameFor(member),
          guildName: member.guild.name,
          memberCount,
        })}`,
      });

      // Wrap the card in an embed so it renders with a colored side-bar + footer member count.
      // The quirky pool is global and generic ("rolled a 20 on initiative"). On a
      // dark card it's the only greeting there is, so it stays. A light card already
      // carries the server's own wording in the artwork, and stacking a stock line
      // on top of it undoes the thing the owner picked.
      if (style === 'text') {
        // Plain-text style: the text as the message, the picture under it, no embed around either.
        return { banner: true, style, payload: { content: clip(messageContent, 2000), files: [attachment] } };
      }
      const embed = new EmbedBuilder()
        .setColor(embedColor(config.embed_color) ?? (light ? 0x8FC7F0 : 0xCDC3FF))
        .setDescription(clip(messageContent, 4096))
        .setImage('attachment://welcome-image.png')
        .setFooter({ text: `${readableName(member.guild.name)} • Member #${member.guild.memberCount}` })
        .setTimestamp();
      if (!light) embed.setTitle(clip(`👋 ${quirkyPlain}`, 256));

      return { banner: true, style, payload: { content: `<@${member.id}>`, embeds: [embed], files: [attachment] } };
    }

    if (style === 'embed') {
      // Embed style without the banner: the member's name and avatar, the text, the member count.
      // The mention sits above the embed, because a mention inside one does not notify anybody.
      const embed = new EmbedBuilder()
        .setColor(embedColor(config.embed_color) ?? 0xCDC3FF)
        .setAuthor({ name: clip(displayNameFor(member), 256), iconURL: member.user.displayAvatarURL({ size: 128 }) })
        .setDescription(clip(messageContent, 4096))
        .setFooter({ text: `${readableName(member.guild.name)} • Member #${member.guild.memberCount}` })
        .setTimestamp();
      return { banner: false, style, payload: { content: `<@${member.id}>`, embeds: [embed] } };
    }
    return { banner: false, style, payload: { content: clip(messageContent, 2000) } };
  }
}

/**
 * Handle when a member leaves a guild
 * @param {import('discord.js').GuildMember} member - The member who left
 */
export async function handleGuildMemberRemove(member) {
  if (member.user?.bot) return;

  const guildId = member.guild.id;
  try {
    const [rows] = await pool.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [guildId]);

    if (rows.length === 0 || !rows[0].goodbye_enabled || !rows[0].goodbye_channel_id) return;

    const config = rows[0];
    const channel = member.guild.channels.cache.get(config.goodbye_channel_id);
    if (!channel) return;

    let messageContent = renderTemplate(config.goodbye_message || DEFAULT_GOODBYE, {
      member,
      guild: member.guild,
      legacyUser: 'tag',
    });

    let payload;
    if (String(config.goodbye_message_type || '').toLowerCase() === 'embed') {
      const embed = new EmbedBuilder()
        .setColor(0x99AAB5)
        .setAuthor({ name: clip(displayNameFor(member), 256), iconURL: member.user.displayAvatarURL({ size: 128 }) })
        .setDescription(clip(messageContent, 4096))
        .setFooter({ text: `${readableName(member.guild.name)} • ${member.guild.memberCount} members` })
        .setTimestamp();
      payload = { embeds: [embed] };
    } else {
      payload = clip(messageContent, 2000);
    }
    { const _sent = await channel.send(payload); recordBotMessage({ guildId: member.guild?.id, channelId: channel.id, messageId: _sent?.id, templateKey: 'welcome.left', feature: 'welcome' }); }
    logger.info(`Sent goodbye message for ${member.user.tag}.`, {
      guildId,
      category: 'greeting'
    });
  } catch (error) {
    logger.error('Error handling guild member remove.', {
      guildId,
      category: 'greeting',
      error: error.stack
    });
  }
}

/**
 * Give a member their autoroles. The feature lives in core/autoroles.js now (several roles, bot roles,
 * required and ignored roles, a delay, existing members); this keeps the old import working.
 * @param {import('discord.js').GuildMember} member
 * @param {{ source?: string }} [opts]
 */
export async function assignAutoroles(member, opts) {
  return giveAutoroles(member, opts);
}

// guildId -> times of recent ban posts. A raid ban-wave must not turn the channel into a wall.
const recentBanPosts = new Map();
const BAN_POSTS_PER_MINUTE = 5;

/**
 * The ban announcement (welcome_settings.ban_enabled / ban_channel_id / ban_message / ban_message_type),
 * called from events/guildBanAdd.js by the bot that runs the server. {reason} and {moderator} come from
 * the audit-log entry when there is one. Nothing in it can ping anyone: the reason is typed by whoever
 * banned, and the member is already gone. Never throws.
 * @param {import('discord.js').GuildBan} ban
 * @param {{ entry?: import('discord.js').GuildAuditLogsEntry|null }} [opts]
 */
export async function announceBan(ban, { entry = null } = {}) {
  const guild = ban?.guild;
  const user = ban?.user;
  if (!guild || !user) return;
  try {
    const [rows] = await pool.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [guild.id]);
    const config = rows[0];
    if (!config || !Number(config.ban_enabled) || !config.ban_channel_id) return;
    const channel = guild.channels.cache.get(config.ban_channel_id);
    if (!channel || !channel.isTextBased?.()) return;

    const now = Date.now();
    const recent = (recentBanPosts.get(guild.id) || []).filter((t) => now - t < 60000);
    if (recent.length >= BAN_POSTS_PER_MINUTE) {
      recentBanPosts.set(guild.id, recent);
      logger.info(`[GreetingManager] Ban announcement for ${user.tag ?? user.id} skipped: ${BAN_POSTS_PER_MINUTE} already posted this minute`, { guildId: guild.id, category: 'greeting' });
      return;
    }
    recent.push(now);
    recentBanPosts.set(guild.id, recent);
    if (recentBanPosts.size > 2000) for (const [k, v] of recentBanPosts) if (!v.some((t) => now - t < 60000)) recentBanPosts.delete(k);

    const banner = entry?.executor || null;
    const reason = String(entry?.reason ?? ban.reason ?? '').trim();
    const text = renderTemplate(config.ban_message || DEFAULT_BAN, {
      user,
      guild,
      legacyUser: 'tag',
      extra: {
        reason: reason || 'No reason given',
        moderator: banner ? (banner.tag ?? banner.username) : 'Unknown',
      },
    });

    let payload;
    if (String(config.ban_message_type || '').toLowerCase() === 'embed') {
      const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setAuthor({ name: clip(user.tag ?? user.username, 256), iconURL: user.displayAvatarURL({ size: 128 }) })
        .setDescription(clip(text, 4096))
        .setFooter({ text: readableName(guild.name) })
        .setTimestamp();
      payload = { embeds: [embed], allowedMentions: { parse: [] } };
    } else {
      payload = { content: clip(text, 2000), allowedMentions: { parse: [] } };
    }
    const sent = await channel.send(payload);
    recordBotMessage({ guildId: guild.id, channelId: channel.id, messageId: sent?.id, templateKey: 'welcome.banned', feature: 'welcome' });
  } catch (error) {
    logger.warn(`[GreetingManager] Ban announcement failed: ${error.message}`, { guildId: guild.id, category: 'greeting' });
  }
}
