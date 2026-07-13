import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

async function getTempChannelContext(interaction) {
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return { error: 'You need to be in a voice channel to use this command.' };
  }
  const [rows] = await pool.execute(
    'SELECT channel_id, guild_id, owner_id, created_at FROM temp_voice_channels WHERE channel_id = ?',
    [voiceChannel.id]
  );
  if (rows.length === 0) {
    return { error: 'This isn\'t a temp voice channel — these controls only work on rooms created from the join-to-create channel.' };
  }
  return { record: rows[0], voiceChannel, member };
}

function ownerCheck(record, member) {
  if (record.owner_id !== member.id) {
    return 'Only the room owner can do that. Use `/voice claim` if the original owner has left.';
  }
  return null;
}

export default {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Controls for your join-to-create voice room.')
    .setDMPermission(false)
    .addSubcommand(s => s
      .setName('rename').setDescription('Rename your room.')
      .addStringOption(o => o.setName('name').setDescription('New name (max 100 chars).').setRequired(true).setMaxLength(100)))
    .addSubcommand(s => s
      .setName('limit').setDescription('Set the user limit on your room.')
      .addIntegerOption(o => o.setName('count').setDescription('0 for unlimited, otherwise 1-99.').setRequired(true).setMinValue(0).setMaxValue(99)))
    .addSubcommand(s => s.setName('lock').setDescription('Lock the room — @everyone can\'t connect.'))
    .addSubcommand(s => s.setName('unlock').setDescription('Unlock the room.'))
    .addSubcommand(s => s
      .setName('transfer').setDescription('Hand ownership to someone in the room.')
      .addUserOption(o => o.setName('user').setDescription('New owner.').setRequired(true)))
    .addSubcommand(s => s.setName('claim').setDescription('Claim the room if the original owner has left.'))
    .addSubcommand(s => s
      .setName('kick').setDescription('Disconnect someone from your room.')
      .addUserOption(o => o.setName('user').setDescription('Who to kick.').setRequired(true)))
    .addSubcommand(s => s
      .setName('trust').setDescription('Let someone bypass the lock.')
      .addUserOption(o => o.setName('user').setDescription('Who to trust.').setRequired(true)))
    .addSubcommand(s => s
      .setName('untrust').setDescription('Revoke trust.')
      .addUserOption(o => o.setName('user').setDescription('Who to untrust.').setRequired(true)))
    .addSubcommand(s => s.setName('info').setDescription('Show this room\'s state.')),

  async execute(interaction) {
    const ctx = await getTempChannelContext(interaction);
    if (ctx.error) {
      return interaction.reply({ content: ctx.error, flags: 64 });
    }
    const { record, voiceChannel, member } = ctx;
    const sub = interaction.options.getSubcommand();
    const everyone = interaction.guild.roles.everyone;

    try {
      switch (sub) {
        case 'rename': {
          const ownerErr = ownerCheck(record, member);
          if (ownerErr) return interaction.reply({ content: ownerErr, flags: 64 });
          const name = interaction.options.getString('name', true);
          await voiceChannel.setName(name, `Owner ${member.user.tag} renamed via /voice`);
          return interaction.reply({ content: `Renamed to **${name}**.`, flags: 64 });
        }

        case 'limit': {
          const ownerErr = ownerCheck(record, member);
          if (ownerErr) return interaction.reply({ content: ownerErr, flags: 64 });
          const count = interaction.options.getInteger('count', true);
          await voiceChannel.setUserLimit(count, `Owner ${member.user.tag} via /voice limit`);
          return interaction.reply({ content: count === 0 ? 'User limit removed.' : `User limit set to **${count}**.`, flags: 64 });
        }

        case 'lock': {
          const ownerErr = ownerCheck(record, member);
          if (ownerErr) return interaction.reply({ content: ownerErr, flags: 64 });
          await voiceChannel.permissionOverwrites.edit(everyone, { Connect: false }, { reason: `Owner ${member.user.tag} locked via /voice` });
          return interaction.reply({ content: '🔒 Room locked. Members already inside stay; no new joiners (unless trusted).', flags: 64 });
        }

        case 'unlock': {
          const ownerErr = ownerCheck(record, member);
          if (ownerErr) return interaction.reply({ content: ownerErr, flags: 64 });
          await voiceChannel.permissionOverwrites.edit(everyone, { Connect: null }, { reason: `Owner ${member.user.tag} unlocked via /voice` });
          return interaction.reply({ content: '🔓 Room unlocked.', flags: 64 });
        }

        case 'transfer': {
          const ownerErr = ownerCheck(record, member);
          if (ownerErr) return interaction.reply({ content: ownerErr, flags: 64 });
          const target = interaction.options.getUser('user', true);
          const targetMember = voiceChannel.members.get(target.id);
          if (!targetMember) {
            return interaction.reply({ content: `${target} isn't in this room.`, flags: 64 });
          }
          await pool.execute('UPDATE temp_voice_channels SET owner_id = ? WHERE channel_id = ?', [target.id, voiceChannel.id]);
          return interaction.reply({ content: `👑 Ownership transferred to ${target}.`, flags: 64 });
        }

        case 'claim': {
          const originalOwnerInChannel = voiceChannel.members.has(record.owner_id);
          if (originalOwnerInChannel && record.owner_id !== member.id) {
            return interaction.reply({ content: 'The original owner is still in the room. They can `/voice transfer` if they want to hand it off.', flags: 64 });
          }
          if (record.owner_id === member.id) {
            return interaction.reply({ content: 'You\'re already the owner.', flags: 64 });
          }
          await pool.execute('UPDATE temp_voice_channels SET owner_id = ? WHERE channel_id = ?', [member.id, voiceChannel.id]);
          return interaction.reply({ content: `👑 You\'ve claimed the room, ${member}.`, flags: 64 });
        }

        case 'kick': {
          const ownerErr = ownerCheck(record, member);
          if (ownerErr) return interaction.reply({ content: ownerErr, flags: 64 });
          const target = interaction.options.getUser('user', true);
          const targetMember = voiceChannel.members.get(target.id);
          if (!targetMember) {
            return interaction.reply({ content: `${target} isn't in this room.`, flags: 64 });
          }
          if (target.id === member.id) {
            return interaction.reply({ content: 'You can\'t kick yourself — use the leave button instead.', flags: 64 });
          }
          await targetMember.voice.disconnect(`Kicked by room owner ${member.user.tag}`);
          return interaction.reply({ content: `👢 Kicked ${target}.`, flags: 64 });
        }

        case 'trust': {
          const ownerErr = ownerCheck(record, member);
          if (ownerErr) return interaction.reply({ content: ownerErr, flags: 64 });
          const target = interaction.options.getUser('user', true);
          await voiceChannel.permissionOverwrites.edit(target.id, { Connect: true, ViewChannel: true }, { reason: `Owner ${member.user.tag} trusted via /voice` });
          return interaction.reply({ content: `✅ ${target} can now bypass the lock.`, flags: 64 });
        }

        case 'untrust': {
          const ownerErr = ownerCheck(record, member);
          if (ownerErr) return interaction.reply({ content: ownerErr, flags: 64 });
          const target = interaction.options.getUser('user', true);
          await voiceChannel.permissionOverwrites.delete(target.id, `Owner ${member.user.tag} untrusted via /voice`).catch(() => {});
          return interaction.reply({ content: `🚫 Revoked ${target}'s trust.`, flags: 64 });
        }

        case 'info': {
          const ownerMember = await interaction.guild.members.fetch(record.owner_id).catch(() => null);
          const everyoneOw = voiceChannel.permissionOverwrites.cache.get(everyone.id);
          const locked = everyoneOw?.deny.has(PermissionFlagsBits.Connect) ?? false;
          const trusted = voiceChannel.permissionOverwrites.cache
            .filter(o => o.type === 1 /* member */ && o.allow.has(PermissionFlagsBits.Connect) && o.id !== record.owner_id)
            .map(o => `<@${o.id}>`);

          const embed = new EmbedBuilder()
            .setTitle(`🔧 ${voiceChannel.name}`)
            .setColor(locked ? 0xED4245 : 0x57F287)
            .addFields(
              { name: 'Owner', value: ownerMember ? `${ownerMember}` : `*owner left — anyone can /voice claim*`, inline: true },
              { name: 'State', value: locked ? '🔒 Locked' : '🔓 Open', inline: true },
              { name: 'User limit', value: voiceChannel.userLimit ? String(voiceChannel.userLimit) : '∞', inline: true },
              { name: 'Members', value: String(voiceChannel.members.size), inline: true },
              { name: 'Trusted', value: trusted.length ? trusted.join(' ') : '*none*', inline: false }
            )
            .setFooter({ text: `Channel ID ${voiceChannel.id}` });
          return interaction.reply({ embeds: [embed], flags: 64 });
        }

        default:
          return interaction.reply({ content: 'Unknown subcommand.', flags: 64 });
      }
    } catch (e) {
      logger.error(`[/voice ${sub}] failed for ${member.user.tag} in ${voiceChannel.id}: ${e.message}`, { stack: e.stack });
      const reply = { content: `Something went wrong: ${e.message}`, flags: 64 };
      if (interaction.replied || interaction.deferred) return interaction.followUp(reply).catch(() => {});
      return interaction.reply(reply).catch(() => {});
    }
  }
};
