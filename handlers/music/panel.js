import MusicPanel from '../../core/music-panel.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export async function handleCreate(interaction) {
  const guildId = interaction.guild.id;
  const channelId = interaction.channel.id;

  try {
    const [existingPanel] = await pool.execute(
      'SELECT * FROM music_panels WHERE guild_id = ?',
      [guildId]
    );

    if (existingPanel.length > 0) {
      await interaction.reply({
        content: 'A music panel already exists in this server. Please use `/music panel delete` first.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const client = interaction.client;
    const panel = new MusicPanel(client, guildId);
    const message = await panel.createPanel(interaction.channel);

    await pool.execute(
      'INSERT INTO music_panels (guild_id, channel_id, message_id) VALUES (?, ?, ?)',
      [guildId, channelId, message.id]
    );

    client.musicPanelManager.set(guildId, panel);

    await interaction.editReply({ content: 'Music panel created successfully!' });
  } catch (error) {
    logger.error('[Music Panel Create Error]', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'An error occurred while creating the music panel.' });
    } else {
      await interaction.reply({
        content: 'An error occurred while creating the music panel.',
        ephemeral: true
      });
    }
  }
}

export async function handleDelete(interaction) {
  const guildId = interaction.guild.id;

  try {
    await interaction.deferReply({ ephemeral: true });

    const [existingPanel] = await pool.execute(
      'SELECT * FROM music_panels WHERE guild_id = ?',
      [guildId]
    );

    if (existingPanel.length === 0) {
      await interaction.editReply({ content: 'No music panel found to delete.' });
      return;
    }

    const panelConfig = existingPanel[0];
    if (!panelConfig) {
      await interaction.editReply({ content: 'Music panel not found.' });
      return;
    }

    try {
      const channel = await interaction.client.channels.fetch(panelConfig.channel_id);
      const message = await channel.messages.fetch(panelConfig.message_id);
      await message.delete();
    } catch (e) {
      logger.warn(`[Music Panel Delete] Could not delete panel message for guild ${guildId}: ${e.message}`);
    }

    await pool.execute('DELETE FROM music_panels WHERE guild_id = ?', [guildId]);

    const client = interaction.client;
    client.musicPanelManager.delete(guildId);

    await interaction.editReply({ content: 'Music panel deleted successfully.' });

  } catch (error) {
    logger.error('[Music Panel Delete Error]', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'An error occurred while deleting the music panel.' });
    } else {
      await interaction.reply({
        content: 'An error occurred while deleting the music panel.',
        ephemeral: true
      });
    }
  }
}
