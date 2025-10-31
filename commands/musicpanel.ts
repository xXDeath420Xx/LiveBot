import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChatInputCommandInteraction,
    CacheType,
    TextChannel
} from 'discord.js';
import { RowDataPacket } from 'mysql2';
import MusicPanel from '../core/music-panel';
import db from '../utils/db';
import logger from '../utils/logger';

interface MusicPanelRow extends RowDataPacket {
    guild_id: string;
    channel_id: string;
    message_id: string;
}

interface ExtendedClient {
    player: any;
    musicPanelManager: Map<string, MusicPanel>;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('musicpanel')
        .setDescription('Manages the music control panel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('create')
                .setDescription('Creates the music control panel in the current channel.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Deletes the music control panel from the server.')
        ),

    async execute(interaction: ChatInputCommandInteraction<CacheType>): Promise<void> {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild!.id;

        if (subcommand === 'create') {
            const channelId = interaction.channel!.id;

            try {
                const [existingPanel] = await db.execute<MusicPanelRow[]>(
                    'SELECT * FROM music_panels WHERE guild_id = ?',
                    [guildId]
                );

                if (existingPanel.length > 0) {
                    await interaction.reply({
                        content: 'A music panel already exists in this server. Please use `/musicpanel delete` first.',
                        ephemeral: true
                    });
                    return;
                }

                await interaction.deferReply({ ephemeral: true });

                const client = interaction.client as unknown as ExtendedClient;
                const queue = client.player.nodes.get(guildId);
                const panel = new MusicPanel(client as any, queue);
                const message = await panel.createPanel(interaction.channel as TextChannel);

                await db.execute(
                    'INSERT INTO music_panels (guild_id, channel_id, message_id) VALUES (?, ?, ?)',
                    [guildId, channelId, message.id]
                );

                client.musicPanelManager.set(guildId, panel);

                await interaction.editReply({ content: 'Music panel created successfully!' });
            } catch (error) {
                logger.error('[Music Panel Create Error]', error as Record<string, any>);
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: 'An _error occurred while creating the music panel.' });
                } else {
                    await interaction.reply({
                        content: 'An _error occurred while creating the music panel.',
                        ephemeral: true
                    });
                }
            }
        } else if (subcommand === 'delete') {
            try {
                await interaction.deferReply({ ephemeral: true });

                const [existingPanel] = await db.execute<MusicPanelRow[]>(
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
                    const channel = await interaction.client.channels.fetch(panelConfig.channel_id) as TextChannel;
                    const message = await channel.messages.fetch(panelConfig.message_id);
                    await message.delete();
                } catch (e) {
                    logger.warn(`[Music Panel Delete] Could not delete panel message for guild ${guildId}: ${(e as Error).message}`);
                }

                await db.execute('DELETE FROM music_panels WHERE guild_id = ?', [guildId]);

                const client = interaction.client as unknown as ExtendedClient;
                client.musicPanelManager.delete(guildId);

                await interaction.editReply({ content: 'Music panel deleted successfully.' });

            } catch (error) {
                logger.error('[Music Panel Delete Error]', error as Record<string, any>);
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: 'An _error occurred while deleting the music panel.' });
                } else {
                    await interaction.reply({
                        content: 'An _error occurred while deleting the music panel.',
                        ephemeral: true
                    });
                }
            }
        }
    },

    category: 'music'
};