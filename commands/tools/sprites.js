// Discord slash command: /sprites
// Subcommands:
//   /sprites link <code>            — link Discord to sprite tracker account
//   /sprites unlink                 — remove the link + delete all owned embeds
//   /sprites embed <type> [channel] — post/re-post auto-updating embed
//   /sprites remove-embed <type>    — take down an embed in this channel
//   /sprites status                 — show link status + active embeds
//
// The 6-digit link code is generated on the sprite tracker web side
// (/sprites/discord-connect) and consumed here. Codes expire after 5 min.

import { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getConfig as getFeatureConfig } from '../../core/feature-config.js';
import { buildCollectionEmbed, buildBuybackEmbed } from '../../core/spriteEmbedBuilder.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

// In-memory linking code cache — codes issued by the web side, consumed here.
// Shared with the web routes via a global singleton so both the Express server
// and the bot see the same map. Cleared after consumption or 5 min TTL.
if (!globalThis.__spriteLinkCodes) globalThis.__spriteLinkCodes = new Map();
const LINK_CODES = globalThis.__spriteLinkCodes;
function consumeLinkCode(code) {
  const entry = LINK_CODES.get(code);
  if (!entry) return null;
  if (Date.now() - entry.issuedAt > 5 * 60 * 1000) { LINK_CODES.delete(code); return null; }
  LINK_CODES.delete(code);
  return entry;
}

async function getLinkedAccount(discordUserId) {
  const [rows] = await pool.execute(
    'SELECT sprite_account_id, linked_at FROM epic_sprite_discord_links WHERE discord_user_id = ?',
    [discordUserId],
  );
  return rows[0] || null;
}

async function fetchSpriteState(accountId) {
  const [rows] = await pool.execute(
    'SELECT display_name, share_id, state_json, synced_at FROM epic_sprite_accounts WHERE account_id = ?',
    [accountId],
  );
  if (!rows.length) return null;
  const state = JSON.parse(rows[0].state_json || '{}');
  state.player = rows[0].display_name;
  state.syncedAt = rows[0].synced_at?.toISOString?.() || rows[0].synced_at;
  return { state, shareId: rows[0].share_id, displayName: rows[0].display_name };
}

async function fetchBuybackList(accountId) {
  const [rows] = await pool.execute(
    'SELECT variant_name, source FROM epic_sprite_buyback WHERE account_id = ? ORDER BY added_at DESC',
    [accountId],
  );
  return rows;
}

export default {
  category: 'tools',
  data: new SlashCommandBuilder()
    .setName('sprites')
    .setDescription('Fortnite Sprite Tracker integration — link your collection to Discord')
    .addSubcommand((sub) =>
      sub.setName('link')
        .setDescription('Link this Discord account to your Sprite Tracker profile')
        .addStringOption((opt) =>
          opt.setName('code')
            .setDescription('6-digit code from certifriedmultitool.com/sprites/discord-connect')
            .setRequired(true)
            .setMinLength(6)
            .setMaxLength(6),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('unlink')
        .setDescription('Remove the link between this Discord account and your Sprite Tracker'),
    )
    .addSubcommand((sub) =>
      sub.setName('embed')
        .setDescription('Post an auto-updating sprite embed to a channel')
        .addStringOption((opt) =>
          opt.setName('type')
            .setDescription('What to show')
            .setRequired(true)
            .addChoices(
              { name: 'Collection summary', value: 'collection' },
              { name: 'Buy-back list', value: 'buyback' },
            ),
        )
        .addChannelOption((opt) =>
          opt.setName('channel')
            .setDescription('Channel to post in (defaults to the server\'s sprite embed channel, else this one)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('remove-embed')
        .setDescription('Delete an active sprite embed in this channel')
        .addStringOption((opt) =>
          opt.setName('type')
            .setDescription('Which embed to remove')
            .setRequired(true)
            .addChoices(
              { name: 'Collection summary', value: 'collection' },
              { name: 'Buy-back list', value: 'buyback' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('status')
        .setDescription('Show your link status + active embeds'),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'link') return await handleLink(interaction);
      if (sub === 'unlink') return await handleUnlink(interaction);
      if (sub === 'embed') return await handleEmbed(interaction);
      if (sub === 'remove-embed') return await handleRemoveEmbed(interaction);
      if (sub === 'status') return await handleStatus(interaction);
    } catch (err) {
      logger.error?.('[sprites-command]', err);
      console.error('[sprites-command]', err);
      const method = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
      return interaction[method]({ content: `❌ Something went wrong: ${err.message}`, ...EPHEMERAL });
    }
  },
};

async function handleLink(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const code = interaction.options.getString('code', true).trim();
  const entry = consumeLinkCode(code);
  if (!entry) {
    return interaction.editReply({
      content: `❌ That code is invalid or expired. Get a fresh one at <https://certifriedmultitool.com/sprites/discord-connect>.`,
    });
  }
  const existing = await getLinkedAccount(interaction.user.id);
  if (existing && existing.sprite_account_id !== entry.accountId) {
    return interaction.editReply({
      content: `⚠️ Your Discord is already linked to a different sprite account. Run \`/tools sprites unlink\` first if you want to switch.`,
    });
  }
  await pool.execute(
    'INSERT INTO epic_sprite_discord_links (discord_user_id, sprite_account_id, linked_at) VALUES (?, ?, NOW()) ' +
    'ON DUPLICATE KEY UPDATE sprite_account_id = VALUES(sprite_account_id), linked_at = NOW()',
    [interaction.user.id, entry.accountId],
  );
  return interaction.editReply({
    content: `✅ Linked to **${entry.displayName}**. You can now use \`/tools sprites embed\` to post an auto-updating tracker in any channel.`,
  });
}

async function handleUnlink(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const link = await getLinkedAccount(interaction.user.id);
  if (!link) {
    return interaction.editReply({ content: `You're not linked. Use \`/tools sprites link\` first.` });
  }
  // Also delete any embeds this Discord user posted (attempt to unpost them first)
  const [embeds] = await pool.execute(
    'SELECT * FROM epic_sprite_discord_embeds WHERE sprite_account_id = ? AND posted_by_discord_id = ?',
    [link.sprite_account_id, interaction.user.id],
  );
  let removedMessages = 0;
  for (const e of embeds) {
    try {
      const ch = await interaction.client.channels.fetch(e.channel_id).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(e.message_id).catch(() => null);
        if (msg) { await msg.delete().catch(() => {}); removedMessages++; }
      }
    } catch { /* best-effort */ }
  }
  await pool.execute(
    'DELETE FROM epic_sprite_discord_embeds WHERE sprite_account_id = ? AND posted_by_discord_id = ?',
    [link.sprite_account_id, interaction.user.id],
  );
  await pool.execute('DELETE FROM epic_sprite_discord_links WHERE discord_user_id = ?', [interaction.user.id]);
  return interaction.editReply({
    content: `✅ Unlinked${removedMessages ? ` · removed **${removedMessages}** embed(s) from Discord` : ''}.`,
  });
}

async function handleEmbed(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const link = await getLinkedAccount(interaction.user.id);
  if (!link) {
    return interaction.editReply({
      content: `❌ You need to link first. Get a code at <https://certifriedmultitool.com/sprites/discord-connect>, then run \`/tools sprites link <code>\`.`,
    });
  }
  const type = interaction.options.getString('type', true);
  // No channel picked: the Fortnite Sprites page's "Collection embed channel", else this channel.
  let channel = interaction.options.getChannel('channel');
  if (!channel) {
    const { embed_channel_id: configuredId } = await getFeatureConfig('sprites', interaction.guildId);
    channel = (configuredId && interaction.guild.channels.cache.get(String(configuredId))) || interaction.channel;
  }
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return interaction.editReply({ content: `❌ I can only post embeds to text channels.` });
  }
  // Bot needs Send Messages + Embed Links in the target channel
  const perms = channel.permissionsFor(interaction.guild.members.me);
  if (!perms.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.editReply({
      content: `❌ I need **Send Messages** + **Embed Links** in <#${channel.id}>.`,
    });
  }
  const sprite = await fetchSpriteState(link.sprite_account_id);
  if (!sprite) {
    return interaction.editReply({ content: `❌ Couldn't fetch your sprite state. Try syncing on the web first.` });
  }
  const publicUrl = sprite.shareId
    ? `https://certifriedmultitool.com/sprites/u/${encodeURIComponent(sprite.shareId)}`
    : null;
  let embed;
  if (type === 'collection') {
    embed = buildCollectionEmbed(sprite.state, {
      player: sprite.displayName,
      syncedAt: sprite.state.syncedAt,
      publicUrl,
    });
  } else {
    const buybackList = await fetchBuybackList(link.sprite_account_id);
    embed = buildBuybackEmbed(sprite.state, buybackList, {
      player: sprite.displayName,
      syncedAt: sprite.state.syncedAt,
      publicUrl: publicUrl ? `${publicUrl}/buyback` : null,
    });
  }
  // Check for an existing embed of same type in same channel — edit vs. post
  const [existing] = await pool.execute(
    'SELECT * FROM epic_sprite_discord_embeds WHERE sprite_account_id = ? AND channel_id = ? AND embed_type = ?',
    [link.sprite_account_id, channel.id, type],
  );
  if (existing.length) {
    // Try to edit; if the old message is gone, post a new one and update row
    const row = existing[0];
    try {
      const oldMsg = await channel.messages.fetch(row.message_id);
      await oldMsg.edit({ embeds: [embed] });
      await pool.execute(
        'UPDATE epic_sprite_discord_embeds SET updated_at = NOW(), last_refresh_at = NOW(), broken = 0 WHERE id = ?',
        [row.id],
      );
      return interaction.editReply({
        content: `✅ Refreshed existing ${type} embed in <#${channel.id}>. It will auto-update on every sync.`,
      });
    } catch { /* fall through — old msg gone */ }
    const newMsg = await channel.send({ embeds: [embed] });
    await pool.execute(
      'UPDATE epic_sprite_discord_embeds SET message_id = ?, posted_by_discord_id = ?, bot_id = ?, updated_at = NOW(), last_refresh_at = NOW(), broken = 0 WHERE id = ?',
      [newMsg.id, interaction.user.id, interaction.client.user.id, row.id],
    );
    return interaction.editReply({
      content: `✅ Posted new ${type} embed in <#${channel.id}> (old one was missing).`,
    });
  }
  // Fresh post
  const newMsg = await channel.send({ embeds: [embed] });
  await pool.execute(
    'INSERT INTO epic_sprite_discord_embeds (sprite_account_id, guild_id, channel_id, message_id, posted_by_discord_id, embed_type, bot_id, created_at, last_refresh_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
    [link.sprite_account_id, interaction.guild.id, channel.id, newMsg.id, interaction.user.id, type, interaction.client.user.id],
  );
  return interaction.editReply({
    content: `✅ Posted ${type} embed in <#${channel.id}>. It will auto-update every time your collection syncs.`,
  });
}

async function handleRemoveEmbed(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const link = await getLinkedAccount(interaction.user.id);
  if (!link) {
    return interaction.editReply({ content: `You're not linked.` });
  }
  const type = interaction.options.getString('type', true);
  const [rows] = await pool.execute(
    'SELECT * FROM epic_sprite_discord_embeds WHERE sprite_account_id = ? AND channel_id = ? AND embed_type = ?',
    [link.sprite_account_id, interaction.channel.id, type],
  );
  if (!rows.length) {
    return interaction.editReply({ content: `No ${type} embed of yours in this channel.` });
  }
  for (const row of rows) {
    try {
      const msg = await interaction.channel.messages.fetch(row.message_id).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    } catch { /* best-effort */ }
  }
  await pool.execute(
    'DELETE FROM epic_sprite_discord_embeds WHERE sprite_account_id = ? AND channel_id = ? AND embed_type = ?',
    [link.sprite_account_id, interaction.channel.id, type],
  );
  return interaction.editReply({ content: `✅ Removed ${type} embed from this channel.` });
}

async function handleStatus(interaction) {
  await interaction.deferReply(EPHEMERAL);
  const link = await getLinkedAccount(interaction.user.id);
  if (!link) {
    return interaction.editReply({
      content: `❌ Not linked. Get started at <https://certifriedmultitool.com/sprites/discord-connect>.`,
    });
  }
  const sprite = await fetchSpriteState(link.sprite_account_id);
  const [embeds] = await pool.execute(
    'SELECT guild_id, channel_id, embed_type, broken, last_refresh_at FROM epic_sprite_discord_embeds WHERE posted_by_discord_id = ?',
    [interaction.user.id],
  );
  const lines = embeds.map((e) => {
    const state = e.broken ? '⚠️ broken' : '✓ active';
    const ago = e.last_refresh_at ? Math.round((Date.now() - new Date(e.last_refresh_at).getTime()) / 60000) + ' min ago' : 'never';
    return `${state} · **${e.embed_type}** in <#${e.channel_id}> · last refresh: ${ago}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x7b5cff)
    .setTitle(`🎯 Sprite Tracker link`)
    .setDescription(
      `Linked to: **${sprite?.displayName || 'Unknown'}**\n` +
      `Linked since: <t:${Math.floor(new Date(link.linked_at).getTime() / 1000)}:R>`
    )
    .addFields({
      name: `Active embeds (${embeds.length})`,
      value: lines.length ? lines.join('\n') : '_No embeds yet. Use `/tools sprites embed` to post one._',
    })
    .setFooter({ text: 'certifriedmultitool.com/sprites' });
  return interaction.editReply({ embeds: [embed] });
}

// ── Public: refreshAllEmbedsForAccount ────────────────────────────────────
// Called from the periodic sync path when an account's state_json changes.
// Rebuilds every embed row for the account + edits the underlying Discord
// message. Rate-limits by only refreshing embeds not touched in the last 30s
// (prevents rapid re-syncs from thrashing the Discord API).
//
// clientOrResolver: either a Discord.js Client instance, OR a function
// `(guildId) => Client` — the second form is used by the web app to route
// through per-guild custom bots via BotManager.getClientForGuild.
export async function refreshAllEmbedsForAccount(spriteAccountId, clientOrResolver) {
  if (!clientOrResolver) return;
  const resolveClient = typeof clientOrResolver === 'function'
    ? clientOrResolver
    : () => clientOrResolver;

  // Include rows previously flagged `broken` when they have not been retried for a while. A message
  // can come back (channel un-hidden, permissions restored, or the flag was set by a transient blip
  // during a restart), and without this an embed stays dead forever with nothing to un-stick it.
  const [embeds] = await pool.execute(
    `SELECT * FROM epic_sprite_discord_embeds
      WHERE sprite_account_id = ?
        AND (broken = 0
             OR last_refresh_at IS NULL
             OR last_refresh_at < DATE_SUB(NOW(), INTERVAL 1 HOUR))`,
    [spriteAccountId],
  );
  if (!embeds.length) return;
  const [rows] = await pool.execute(
    'SELECT display_name, share_id, state_json, synced_at FROM epic_sprite_accounts WHERE account_id = ?',
    [spriteAccountId],
  );
  if (!rows.length) return;
  const state = JSON.parse(rows[0].state_json || '{}');
  state.player = rows[0].display_name;
  state.syncedAt = rows[0].synced_at?.toISOString?.() || rows[0].synced_at;
  const publicUrl = rows[0].share_id
    ? `https://certifriedmultitool.com/sprites/u/${encodeURIComponent(rows[0].share_id)}`
    : null;
  const [buybackList] = await pool.execute(
    'SELECT variant_name FROM epic_sprite_buyback WHERE account_id = ?',
    [spriteAccountId],
  );

  const now = Date.now();
  const collectionEmbed = buildCollectionEmbed(state, { player: rows[0].display_name, syncedAt: state.syncedAt, publicUrl });
  const buybackEmbed = buildBuybackEmbed(state, buybackList, {
    player: rows[0].display_name, syncedAt: state.syncedAt,
    publicUrl: publicUrl ? `${publicUrl}/buyback` : null,
  });

  for (const e of embeds) {
    // Skip if refreshed in last 30s (avoid Discord rate limits)
    if (e.last_refresh_at && (now - new Date(e.last_refresh_at).getTime()) < 30 * 1000) continue;
    const client = resolveClient(e.guild_id);
    if (!client) continue;
    try {
      // Distinguish PERMANENT failures from TRANSIENT ones.
      //
      // Marking `broken` is a one-way door: the query above only selects `broken = 0`, so a row that
      // gets flagged is never retried. A restart used to be enough to kill an embed forever — the
      // custom bot's client was mid-connect, `channels.fetch` came back empty, and we recorded that
      // momentary blip as "broken" even though the channel was perfectly fine one minute later.
      // Only Discord telling us the thing genuinely no longer exists (10003 Unknown Channel /
      // 10008 Unknown Message) or that we have lost access (50001) is permanent; everything else is
      // left alone so the next sync can simply try again.
      const permanent = (err) => [10003, 10008, 50001].includes(err?.code);

      let channel = null;
      try { channel = await client.channels.fetch(e.channel_id); }
      catch (err) {
        if (permanent(err)) throw Object.assign(new Error('channel_gone'), { permanent: true });
        throw new Error(`channel_unavailable (${err?.code || err?.message || 'unknown'})`);
      }
      if (!channel) throw new Error('channel_unavailable (empty)');

      let msg = null;
      try { msg = await channel.messages.fetch(e.message_id); }
      catch (err) {
        if (permanent(err)) throw Object.assign(new Error('message_gone'), { permanent: true });
        throw new Error(`message_unavailable (${err?.code || err?.message || 'unknown'})`);
      }
      if (!msg) throw new Error('message_unavailable (empty)');

      await msg.edit({ embeds: [e.embed_type === 'collection' ? collectionEmbed : buybackEmbed] });
      await pool.execute(
        'UPDATE epic_sprite_discord_embeds SET last_refresh_at = NOW(), updated_at = NOW(), broken = 0 WHERE id = ?',
        [e.id],
      );
    } catch (err) {
      if (err.permanent) {
        // Stamp last_refresh_at too: the hourly re-check in the query above keys off it, and without
        // the stamp a broken row matched "not retried for an hour" forever and was re-checked (and
        // warned about) on every sync. Warn once, on the way into broken.
        if (!e.broken) logger.warn?.(`[sprites-embed-refresh] id=${e.id} permanently broken: ${err.message}`);
        await pool.execute('UPDATE epic_sprite_discord_embeds SET broken = 1, last_refresh_at = NOW() WHERE id = ?', [e.id]);
      } else {
        // Transient — leave `broken` alone so the next sync retries it.
        logger.warn?.(`[sprites-embed-refresh] id=${e.id} transient failure, will retry: ${err.message}`);
      }
    }
  }
}
