import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import { initState as lastLetterInit } from '../../core/games/last-letter.js';
import { initState as storyInit, renderStory } from '../../core/games/one-word-story.js';
import { initState as coordleInit } from '../../core/games/coordle.js';
import { boardEmbed as coordleBoardEmbed } from '../../core/games/coordle-runtime.js';
import * as wordBank from '../../core/word-bank.js';
import {
  createSession, endSession, getSessionByChannel, bindChannel, unbindChannel,
  saveState, getStats, getLeaderboard,
} from '../../core/word-game-manager.js';

// Posts the initial Coordle board and records its message id on the session.
async function startCoordleBoard(interaction, session) {
  try {
    const sent = await interaction.channel.send({ embeds: [coordleBoardEmbed(session.state)] });
    session.state.boardMessageId = sent.id;
    await saveState(session);
  } catch { /* board can be re-created lazily on first guess */ }
}

// Per-group game metadata. Adding a new typed game = add an entry + a subcommand group.
const GAMES = {
  lastletter: {
    type: 'last_letter', label: 'Last Letter', emoji: '🔤',
    init: () => lastLetterInit(),
    startBlurb: 'Post a word — each next word must begin with the previous word’s last letter. No repeats, real words only.',
    statLines: (st) => `Words contributed: **${st.words_contributed}**\nLongest chain: **${st.best_score}**`,
    lbLine: (r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.words_contributed} words (best chain ${r.best_score})`,
    endLine: (s) => `🏁 Last Letter ended after **${s.state.count}** words.`,
  },
  story: {
    type: 'one_word_story', label: 'One Word Story', emoji: '📖',
    init: () => storyInit(),
    startBlurb: 'Add **one word** at a time to build a story together — you can’t go twice in a row.',
    statLines: (st) => `Words contributed: **${st.words_contributed}**\nLongest story: **${st.best_score}**`,
    lbLine: (r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.words_contributed} words`,
    endLine: (s) => `🏁 Story ended with **${s.state.words.length}** words.`,
  },
  coordle: {
    type: 'coordle', label: 'Coordle', emoji: '🟩',
    init: () => coordleInit(wordBank.randomAnswer(5) || 'crane'),
    afterStart: startCoordleBoard,
    startBlurb: 'Guess the secret **5-letter word** together — type 5-letter words. 6 shared guesses.',
    statLines: (st) => `Wins: **${st.wins}** / Played: **${st.games_played}**\nBest solve (higher = fewer guesses): **${st.best_score}**`,
    lbLine: (r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.wins} wins`,
    endLine: (s) => `🏳️ Coordle ended — the word was **${s.state.answer.toUpperCase()}**.`,
  },
};

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
      .addSubcommand(s => s.setName('leaderboard').setDescription('Top Last Letter players')))
    .addSubcommandGroup(g => g
      .setName('story')
      .setDescription('One Word Story: build a story one word at a time')
      .addSubcommand(s => s.setName('setup').setDescription('Bind a persistent One Word Story channel (admin)')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to host the game').addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand(s => s.setName('disable').setDescription('Unbind the One Word Story game from a channel (admin)')
        .addChannelOption(o => o.setName('channel').setDescription('Bound channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand(s => s.setName('start').setDescription('Start a One Word Story round in this channel'))
      .addSubcommand(s => s.setName('end').setDescription('End the story and post the final result'))
      .addSubcommand(s => s.setName('show').setDescription('Show the story so far'))
      .addSubcommand(s => s.setName('stats').setDescription('Your One Word Story stats')
        .addUserOption(o => o.setName('user').setDescription('Whose stats').setRequired(false)))
      .addSubcommand(s => s.setName('leaderboard').setDescription('Top One Word Story players')))
    .addSubcommandGroup(g => g
      .setName('coordle')
      .setDescription('Collaborative Wordle: guess the 5-letter word together')
      .addSubcommand(s => s.setName('setup').setDescription('Bind a persistent Coordle channel (admin)')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to host the game').addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand(s => s.setName('disable').setDescription('Unbind the Coordle game from a channel (admin)')
        .addChannelOption(o => o.setName('channel').setDescription('Bound channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand(s => s.setName('start').setDescription('Start a Coordle puzzle in this channel'))
      .addSubcommand(s => s.setName('end').setDescription('End the Coordle puzzle in this channel'))
      .addSubcommand(s => s.setName('stats').setDescription('Your Coordle stats')
        .addUserOption(o => o.setName('user').setDescription('Whose stats').setRequired(false)))
      .addSubcommand(s => s.setName('leaderboard').setDescription('Top Coordle players'))),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();
    const game = GAMES[group];
    if (!game) return interaction.reply({ content: 'Unknown game.', ephemeral: true });
    const guildId = interaction.guildId;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

    if (sub === 'setup' || sub === 'disable') {
      if (!isAdmin) return interaction.reply({ content: 'You need **Manage Server** to do that.', ephemeral: true });
      const channel = interaction.options.getChannel('channel');
      if (sub === 'setup') {
        if (getSessionByChannel(channel.id)) return interaction.reply({ content: `A word game is already active in ${channel}.`, ephemeral: true });
        await bindChannel({ guildId, channelId: channel.id, gameType: game.type, createdBy: interaction.user.id });
        const setupSession = await createSession({ guildId, channelId: channel.id, gameType: game.type, mode: 'persistent', hostUserId: interaction.user.id, state: game.init() });
        if (game.afterStart) await game.afterStart({ channel }, setupSession);
        return interaction.reply(`${game.emoji} **${game.label}** is now live in ${channel}. ${game.startBlurb}`);
      }
      await unbindChannel(guildId, channel.id);
      return interaction.reply(`🛑 ${game.label} unbound from ${channel}.`);
    }

    if (sub === 'start') {
      if (getSessionByChannel(interaction.channelId)) return interaction.reply({ content: 'A word game is already active in this channel.', ephemeral: true });
      const startSession = await createSession({ guildId, channelId: interaction.channelId, gameType: game.type, mode: 'round', hostUserId: interaction.user.id, state: game.init() });
      await interaction.reply(`${game.emoji} **${game.label}** round started! ${game.startBlurb}`);
      if (game.afterStart) await game.afterStart({ channel: interaction.channel }, startSession);
      return;
    }

    if (sub === 'show') { // story only
      const session = getSessionByChannel(interaction.channelId);
      if (!session || session.gameType !== game.type) return interaction.reply({ content: `No ${game.label} game is active here.`, ephemeral: true });
      const story = renderStory(session.state);
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`${game.emoji} The story so far`).setColor(0x5865F2)
        .setDescription(story ? story.slice(0, 4000) : '*(empty — add the first word!)*')] });
    }

    if (sub === 'end') {
      const session = getSessionByChannel(interaction.channelId);
      if (!session || session.gameType !== game.type) return interaction.reply({ content: `No ${game.label} game is active here.`, ephemeral: true });
      if (session.mode === 'persistent') return interaction.reply({ content: `This is a persistent game — use \`/wordgame ${group} disable\` to stop it (that also clears the channel binding).`, ephemeral: true });
      await endSession(session, 'ended');
      if (game.type === 'one_word_story') {
        const story = renderStory(session.state);
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`${game.emoji} Final Story`).setColor(0x57F287)
          .setDescription(story ? story.slice(0, 4000) : '*(no words were added)*')] });
      }
      return interaction.reply(game.endLine(session));
    }

    if (sub === 'stats') {
      const user = interaction.options.getUser('user') || interaction.user;
      const st = await getStats(guildId, user.id, game.type);
      const embed = new EmbedBuilder().setTitle(`${game.emoji} ${game.label} — ${user.username}`).setColor(0x5865F2)
        .setDescription(st ? game.statLines(st) : 'No stats yet — play a round!');
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'leaderboard') {
      const rows = await getLeaderboard(guildId, game.type, 10);
      const lines = rows.length ? rows.map((r, i) => game.lbLine(r, i)).join('\n') : 'No one has played yet.';
      const embed = new EmbedBuilder().setTitle(`${game.emoji} ${game.label} — Leaderboard`).setColor(0x5865F2).setDescription(lines);
      return interaction.reply({ embeds: [embed] });
    }
  },
};
