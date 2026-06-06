import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import { initState } from '../../core/games/last-letter.js';
import {
  createSession, endSession, getSessionByChannel, bindChannel, unbindChannel,
  getStats, getLeaderboard,
} from '../../core/word-game-manager.js';

export default {
  category: 'games',
  data: new SlashCommandBuilder()
    .setName('wordgame')
    .setDescription('Community word games')
    .addSubcommandGroup(g => g
      .setName('lastletter')
      .setDescription('Word-chain: each word starts with the previous word’s last letter')
      .addSubcommand(s => s.setName('setup').setDescription('Bind a persistent Last Letter channel (admin)')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to host the game').addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand(s => s.setName('disable').setDescription('Unbind the Last Letter game from a channel (admin)')
        .addChannelOption(o => o.setName('channel').setDescription('Bound channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand(s => s.setName('start').setDescription('Start a Last Letter round in this channel'))
      .addSubcommand(s => s.setName('end').setDescription('End the Last Letter round in this channel'))
      .addSubcommand(s => s.setName('stats').setDescription('Your Last Letter stats')
        .addUserOption(o => o.setName('user').setDescription('Whose stats').setRequired(false)))
      .addSubcommand(s => s.setName('leaderboard').setDescription('Top Last Letter players'))),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();
    if (group !== 'lastletter') return interaction.reply({ content: 'Unknown game.', ephemeral: true });
    const gameType = 'last_letter';
    const guildId = interaction.guildId;

    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

    if (sub === 'setup' || sub === 'disable') {
      if (!isAdmin) return interaction.reply({ content: 'You need **Manage Server** to do that.', ephemeral: true });
      const channel = interaction.options.getChannel('channel');
      if (sub === 'setup') {
        if (getSessionByChannel(channel.id)) return interaction.reply({ content: `A word game is already active in ${channel}.`, ephemeral: true });
        await bindChannel({ guildId, channelId: channel.id, gameType, createdBy: interaction.user.id });
        await createSession({ guildId, channelId: channel.id, gameType, mode: 'persistent', hostUserId: interaction.user.id, state: initState() });
        return interaction.reply(`✅ Last Letter is now live in ${channel}. Post a word to start the chain — each next word must begin with the previous word’s last letter.`);
      }
      await unbindChannel(guildId, channel.id);
      return interaction.reply(`🛑 Last Letter unbound from ${channel}.`);
    }

    if (sub === 'start') {
      if (getSessionByChannel(interaction.channelId)) return interaction.reply({ content: 'A word game is already active in this channel.', ephemeral: true });
      await createSession({ guildId, channelId: interaction.channelId, gameType, mode: 'round', hostUserId: interaction.user.id, state: initState() });
      return interaction.reply('🔤 **Last Letter** round started! Post a word — each next word must begin with the previous word’s last letter. No repeats, real words only.');
    }

    if (sub === 'end') {
      const session = getSessionByChannel(interaction.channelId);
      if (!session || session.gameType !== gameType) return interaction.reply({ content: 'No Last Letter game is active here.', ephemeral: true });
      if (session.mode === 'persistent' && !isAdmin) return interaction.reply({ content: 'This is a persistent game — an admin must `disable` it.', ephemeral: true });
      await endSession(session, 'ended');
      return interaction.reply(`🏁 Last Letter ended after **${session.state.count}** words.`);
    }

    if (sub === 'stats') {
      const user = interaction.options.getUser('user') || interaction.user;
      const st = await getStats(guildId, user.id, gameType);
      const embed = new EmbedBuilder().setTitle(`🔤 Last Letter — ${user.username}`).setColor(0x5865F2)
        .setDescription(st
          ? `Words contributed: **${st.words_contributed}**\nLongest chain: **${st.best_score}**`
          : 'No stats yet — play a round!');
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'leaderboard') {
      const rows = await getLeaderboard(guildId, gameType, 10);
      const lines = rows.length
        ? rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.words_contributed} words (best chain ${r.best_score})`).join('\n')
        : 'No one has played yet.';
      const embed = new EmbedBuilder().setTitle('🔤 Last Letter — Leaderboard').setColor(0x5865F2).setDescription(lines);
      return interaction.reply({ embeds: [embed] });
    }
  },
};
