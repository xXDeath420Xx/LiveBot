/*
 * Emoji management — steal, add, list, remove.
 *
 * Replaces Sx Bot's `/emoji steal`, which is the most-used command in some guilds.
 * Discord's emoji CDN is the only source we trust: a custom emoji token carries its own
 * id, so "stealing" is just re-uploading that id's image under a new name.
 */
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import logger from '../../utils/logger.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const COLOR = 0x5865F2;
const MAX_BYTES = 256 * 1024;           // Discord's hard limit per emoji
const NAME_RE = /^[a-zA-Z0-9_]{2,32}$/;

// <:name:id> or <a:name:id>
const CUSTOM_EMOJI = /<(a)?:([a-zA-Z0-9_]{2,32}):(\d{15,25})>/g;

/** Every custom emoji mentioned in a string, in order, de-duplicated by id. */
export function parseEmojis(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(CUSTOM_EMOJI)) {
    const [, animated, name, id] = m;
    if (!out.has(id)) out.set(id, { id, name, animated: !!animated });
  }
  return [...out.values()];
}

export function cdnUrl({ id, animated }) {
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=256&quality=lossless`;
}

/** Fetch an image, refusing anything Discord would reject anyway. */
async function fetchImage(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) return { ok: false, reason: `download failed (HTTP ${res.status})` };

  const type = res.headers.get('content-type') || '';
  if (!/^image\/(png|jpe?g|gif|webp)/i.test(type)) return { ok: false, reason: `not an image (${type || 'unknown type'})` };

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    return { ok: false, reason: `too large (${(buf.length / 1024).toFixed(0)} KiB, max ${MAX_BYTES / 1024} KiB)` };
  }
  return { ok: true, buffer: buf };
}

/** Slots left, so we fail with a useful message instead of a raw API error. */
function slots(guild) {
  const perTier = { 0: 50, 1: 100, 2: 150, 3: 250 }[guild.premiumTier] ?? 50;
  const used = guild.emojis.cache.filter(e => !e.animated).size;
  const usedAnimated = guild.emojis.cache.filter(e => e.animated).size;
  return { perTier, staticLeft: perTier - used, animatedLeft: perTier - usedAnimated };
}

async function upload(guild, { name, url, reason }) {
  const img = await fetchImage(url);
  if (!img.ok) return { ok: false, reason: img.reason };
  try {
    // X-Audit-Log-Reason must be ASCII.
    const created = await guild.emojis.create({ attachment: img.buffer, name, reason: reason.replace(/[^\x20-\x7E]/g, '') });
    return { ok: true, emoji: created };
  } catch (err) {
    return { ok: false, reason: err.message.replace(/\s+/g, ' ').slice(0, 140) };
  }
}

export default {
  category: 'tools',
  data: new SlashCommandBuilder()
    .setName('emoji')
    .setDescription('Steal, add and manage this server\'s emoji')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuildExpressions)
    .addSubcommand(s => s.setName('steal').setDescription('Copy emoji from another server into this one')
      .addStringOption(o => o.setName('emoji').setDescription('Paste one or more custom emoji').setRequired(true))
      .addStringOption(o => o.setName('name').setDescription('Rename it (only when stealing a single emoji)')))
    .addSubcommand(s => s.setName('add').setDescription('Add an emoji from an image')
      .addStringOption(o => o.setName('name').setDescription('Name (2-32 chars, letters/numbers/underscore)').setRequired(true))
      .addAttachmentOption(o => o.setName('image').setDescription('The image (max 256 KiB)'))
      .addStringOption(o => o.setName('url').setDescription('…or an image URL')))
    .addSubcommand(s => s.setName('remove').setDescription('Delete an emoji from this server')
      .addStringOption(o => o.setName('emoji').setDescription('The emoji to delete').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List this server\'s emoji and remaining slots')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (!interaction.guild) return interaction.reply({ content: 'Emoji only exist in servers.', ...EPHEMERAL });

    const me = interaction.guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
      return interaction.reply({ content: 'I need **Manage Expressions** to do that.', ...EPHEMERAL });
    }

    if (sub === 'list') {
      const { perTier, staticLeft, animatedLeft } = slots(interaction.guild);
      const all = [...interaction.guild.emojis.cache.values()];
      const stat = all.filter(e => !e.animated).map(e => e.toString());
      const anim = all.filter(e => e.animated).map(e => e.toString());
      const embed = new EmbedBuilder().setColor(COLOR)
        .setTitle(`Emoji in ${interaction.guild.name}`)
        .setDescription(all.length ? '' : 'This server has no custom emoji.')
        .setFooter({ text: `${stat.length}/${perTier} static · ${anim.length}/${perTier} animated` });
      if (stat.length) embed.addFields({ name: `Static (${staticLeft} slots left)`, value: stat.join(' ').slice(0, 1024) });
      if (anim.length) embed.addFields({ name: `Animated (${animatedLeft} slots left)`, value: anim.join(' ').slice(0, 1024) });
      return interaction.reply({ embeds: [embed], ...EPHEMERAL });
    }

    if (sub === 'steal') {
      const found = parseEmojis(interaction.options.getString('emoji'));
      if (!found.length) {
        return interaction.reply({
          content: 'I could not find a custom emoji there. Paste the emoji itself (e.g. `<:name:123…>`) — default Discord emoji cannot be stolen.',
          ...EPHEMERAL,
        });
      }

      const rename = interaction.options.getString('name');
      if (rename && found.length > 1) {
        return interaction.reply({ content: 'You can only rename when stealing a **single** emoji.', ...EPHEMERAL });
      }
      if (rename && !NAME_RE.test(rename)) {
        return interaction.reply({ content: 'Names must be 2–32 characters: letters, numbers and underscores.', ...EPHEMERAL });
      }

      await interaction.deferReply();
      const results = [];
      for (const e of found) {
        // Already here? Re-uploading would just burn a slot on a duplicate.
        if (interaction.guild.emojis.cache.has(e.id)) { results.push(`⏭️ **${e.name}** is already in this server.`); continue; }

        const res = await upload(interaction.guild, {
          name: rename || e.name,
          url: cdnUrl(e),
          reason: `Stolen by ${interaction.user.tag}`,
        });
        results.push(res.ok ? `✅ ${res.emoji} \`:${res.emoji.name}:\`` : `❌ **${e.name}** — ${res.reason}`);
      }
      return interaction.editReply(results.join('\n').slice(0, 2000));
    }

    if (sub === 'add') {
      const name = interaction.options.getString('name');
      const attachment = interaction.options.getAttachment('image');
      const url = interaction.options.getString('url');

      if (!NAME_RE.test(name)) {
        return interaction.reply({ content: 'Names must be 2–32 characters: letters, numbers and underscores.', ...EPHEMERAL });
      }
      const source = attachment?.url || url;
      if (!source) return interaction.reply({ content: 'Give me an `image` attachment or a `url`.', ...EPHEMERAL });

      await interaction.deferReply();
      const res = await upload(interaction.guild, { name, url: source, reason: `Added by ${interaction.user.tag}` });
      return interaction.editReply(res.ok ? `✅ Added ${res.emoji} \`:${res.emoji.name}:\`` : `❌ ${res.reason}`);
    }

    if (sub === 'remove') {
      const [target] = parseEmojis(interaction.options.getString('emoji'));
      if (!target) return interaction.reply({ content: 'Paste the custom emoji you want to delete.', ...EPHEMERAL });

      const emoji = interaction.guild.emojis.cache.get(target.id);
      if (!emoji) return interaction.reply({ content: 'That emoji is not from this server.', ...EPHEMERAL });

      try {
        await emoji.delete(`Removed by ${interaction.user.tag}`.replace(/[^\x20-\x7E]/g, ''));
        return interaction.reply({ content: `🗑️ Deleted \`:${emoji.name}:\`.`, ...EPHEMERAL });
      } catch (err) {
        logger.error(`[Emoji] delete failed: ${err.message}`);
        return interaction.reply({ content: `❌ Could not delete it: ${err.message}`, ...EPHEMERAL });
      }
    }
  },
};
