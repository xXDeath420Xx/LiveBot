import { EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import pool from '../../utils/db.js';

export async function handleConfess(interaction) {
  let [[config]] = await pool.execute(
    'SELECT * FROM confession_config WHERE guild_id = ?',
    [interaction.guild.id]
  );

  if (!config || !config.enabled) {
    return interaction.reply({ content: '❌ Confessions are not enabled in this server.', ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId('confession_modal')
    .setTitle('Anonymous Confession');

  const confessionInput = new TextInputBuilder()
    .setCustomId('confession_text')
    .setLabel('Your Confession')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Type your anonymous confession here...')
    .setMinLength(config.min_length || 10)
    .setMaxLength(config.max_length || 1000)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(confessionInput));
  await interaction.showModal(modal);
}

export async function handleConfessModal(interaction) {
  if (interaction.customId !== 'confession_modal') return false;

  const confessionText = interaction.fields.getFieldValue('confession_text');
  await interaction.deferReply({ ephemeral: true });

  const [[config]] = await pool.execute(
    'SELECT * FROM confession_config WHERE guild_id = ?',
    [interaction.guild.id]
  );

  if (!config || !config.enabled) {
    return interaction.editReply({ content: '❌ Confessions are not enabled.' });
  }

  const [[countResult]] = await pool.execute(
    'SELECT COUNT(*) as count FROM confessions WHERE guild_id = ?',
    [interaction.guild.id]
  );

  const confessionNumber = (countResult.count || 0) + 1;

  if (config.require_approval) {
    await pool.execute(
      `INSERT INTO confessions (guild_id, confession_number, content, channel_id, approved) VALUES (?, ?, ?, ?, FALSE)`,
      [interaction.guild.id, confessionNumber, confessionText, config.channel_id]
    );
    return interaction.editReply({ content: '✅ Your confession has been submitted for approval. It will be posted if approved by moderators.' });
  } else {
    const channel = interaction.guild.channels.cache.get(config.channel_id);
    if (!channel) return interaction.editReply({ content: '❌ Confession channel not found.' });

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`📝 Confession #${confessionNumber}`)
      .setDescription(confessionText)
      .setFooter({ text: 'Anonymous' })
      .setTimestamp();

    const message = await channel.send({ embeds: [embed] });

    await pool.execute(
      `INSERT INTO confessions (guild_id, confession_number, content, channel_id, message_id, approved) VALUES (?, ?, ?, ?, ?, TRUE)`,
      [interaction.guild.id, confessionNumber, confessionText, config.channel_id, message.id]
    );

    return interaction.editReply({ content: '✅ Your confession has been posted anonymously!' });
  }
}
