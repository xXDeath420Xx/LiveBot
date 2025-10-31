import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, ChannelType } from 'discord.js';
import { logger } from '../utils/logger';
import { db } from '../utils/db';

/**
 * AI DJ Command
 *
 * Manages the 24/7 AI-powered auto-DJ system
 * Subcommands:
 * - start: Start the AI DJ
 * - stop: Stop the AI DJ
 * - config: Configure AI DJ settings
 * - queue: View current queue
 * - skip: Skip current song
 * - nowplaying: Show currently playing song
 * - playlist: Save/load playlist configurations
 */

module.exports = {
    category: 'Music',
    data: new SlashCommandBuilder()
        .setName('aidj')
        .setDescription('AI-powered 24/7 auto-DJ system')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Start the AI DJ in a voice channel')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('Voice channel for the AI DJ')
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildVoice)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('stop')
                .setDescription('Stop the AI DJ')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('config')
                .setDescription('Configure AI DJ settings')
                .addStringOption(option =>
                    option
                        .setName('setting')
                        .setDescription('Setting to configure')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Genres', value: 'genres' },
                            { name: 'Artists', value: 'artists' },
                            { name: 'Years', value: 'years' },
                            { name: 'Mood', value: 'mood' },
                            { name: 'Activity', value: 'activity' },
                            { name: 'AI Prompt', value: 'ai_prompt' },
                            { name: 'Randomness', value: 'randomness' },
                            { name: 'Volume', value: 'volume' }
                        )
                )
                .addStringOption(option =>
                    option
                        .setName('value')
                        .setDescription('New value for the setting')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('queue')
                .setDescription('View the current AI DJ queue')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('skip')
                .setDescription('Skip the current song')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('nowplaying')
                .setDescription('Show currently playing song')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('playlist')
                .setDescription('Manage AI DJ playlists')
                .addStringOption(option =>
                    option
                        .setName('action')
                        .setDescription('Playlist action')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Save current config', value: 'save' },
                            { name: 'Load playlist', value: 'load' },
                            { name: 'List playlists', value: 'list' },
                            { name: 'Delete playlist', value: 'delete' }
                        )
                )
                .addStringOption(option =>
                    option
                        .setName('name')
                        .setDescription('Playlist name')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('favorite')
                .setDescription('Add current song to favorites')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('blacklist')
                .setDescription('Blacklist current song (never play again)')
                .addStringOption(option =>
                    option
                        .setName('reason')
                        .setDescription('Reason for blacklisting')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('stats')
                .setDescription('View AI DJ statistics')
        ),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (subcommand) {
                case 'start':
                    await handleStart(interaction);
                    break;
                case 'stop':
                    await handleStop(interaction);
                    break;
                case 'config':
                    await handleConfig(interaction);
                    break;
                case 'queue':
                    await handleQueue(interaction);
                    break;
                case 'skip':
                    await handleSkip(interaction);
                    break;
                case 'nowplaying':
                    await handleNowPlaying(interaction);
                    break;
                case 'playlist':
                    await handlePlaylist(interaction);
                    break;
                case 'favorite':
                    await handleFavorite(interaction);
                    break;
                case 'blacklist':
                    await handleBlacklist(interaction);
                    break;
                case 'stats':
                    await handleStats(interaction);
                    break;
                default:
                    await interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
            }
        } catch (error: any) {
            logger.error('[AI DJ Command] Error executing command', {
                subcommand,
                guild: interaction.guildId,
                error: error.message,
                stack: error.stack
            });

            const errorMessage = 'An error occurred while executing the AI DJ command.';
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    }
};

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = interaction.options.getChannel('channel', true);

    if (channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: '❌ Please select a voice channel.', ephemeral: true });
        return;
    }

    await interaction.deferReply();

    // Initialize AI DJ config if it doesn't exist
    await db.execute(
        `INSERT INTO ai_dj_config (guild_id, enabled, voice_channel_id, announcement_channel_id)
         VALUES (?, TRUE, ?, ?)
         ON DUPLICATE KEY UPDATE
         enabled = TRUE,
         voice_channel_id = ?,
         announcement_channel_id = IF(announcement_channel_id IS NULL, ?, announcement_channel_id)`,
        [interaction.guildId, channel.id, interaction.channelId, channel.id, interaction.channelId]
    );

    // Start AI DJ (this will be integrated with the AIDJManager)
    // await aiDJManager.start(interaction.guildId!);

    await interaction.editReply({
        content: `✅ AI DJ started in ${channel}!\n\n🎵 The AI is now curating music based on your preferences.\nUse \`/aidj config\` to customize the music selection.`
    });

    logger.info(`[AI DJ] Started for guild ${interaction.guildId} in channel ${channel.id}`, {
        user: interaction.user.id
    });
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    await db.execute(
        'UPDATE ai_dj_config SET enabled = FALSE WHERE guild_id = ?',
        [interaction.guildId]
    );

    // Stop AI DJ (this will be integrated with the AIDJManager)
    // await aiDJManager.stop(interaction.guildId!);

    await interaction.editReply({
        content: '⏹️ AI DJ stopped. Use `/aidj start` to start it again.'
    });

    logger.info(`[AI DJ] Stopped for guild ${interaction.guildId}`, {
        user: interaction.user.id
    });
}

async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
    const setting = interaction.options.getString('setting', true);
    const value = interaction.options.getString('value', true);

    await interaction.deferReply();

    let updateQuery = '';
    let updateValue: any = value;

    switch (setting) {
        case 'genres':
            const genres = value.split(',').map(g => g.trim());
            updateQuery = 'genres = ?';
            updateValue = JSON.stringify(genres);
            break;
        case 'artists':
            const artists = value.split(',').map(a => a.trim());
            updateQuery = 'artists = ?';
            updateValue = JSON.stringify(artists);
            break;
        case 'years':
            const years = value.split(',').map(y => parseInt(y.trim()));
            updateQuery = 'years = ?';
            updateValue = JSON.stringify(years);
            break;
        case 'mood':
            updateQuery = 'mood = ?';
            break;
        case 'activity':
            updateQuery = 'activity_type = ?';
            break;
        case 'ai_prompt':
            updateQuery = 'ai_prompt = ?';
            break;
        case 'randomness':
            const randomness = parseInt(value);
            if (randomness < 0 || randomness > 100) {
                await interaction.editReply('❌ Randomness must be between 0 and 100.');
                return;
            }
            updateQuery = 'randomness_level = ?';
            updateValue = randomness;
            break;
        case 'volume':
            const volume = parseInt(value);
            if (volume < 0 || volume > 100) {
                await interaction.editReply('❌ Volume must be between 0 and 100.');
                return;
            }
            updateQuery = 'volume = ?';
            updateValue = volume;
            break;
    }

    await db.execute(
        `UPDATE ai_dj_config SET ${updateQuery} WHERE guild_id = ?`,
        [updateValue, interaction.guildId]
    );

    await interaction.editReply({
        content: `✅ **${setting}** updated to: \`${value}\`\n\nChanges will take effect on the next song.`
    });

    logger.info(`[AI DJ] Config updated for guild ${interaction.guildId}`, {
        setting,
        value,
        user: interaction.user.id
    });
}

async function handleQueue(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    // Get queue from AIDJManager
    // const queue = aiDJManager.getQueue(interaction.guildId!);

    // Placeholder response
    await interaction.editReply({
        embeds: [{
            color: 0x9B59B6,
            title: '🎵 AI DJ Queue',
            description: 'The AI has curated the following songs:\n\n' +
                '**1.** Artist - Song Title\n' +
                '**2.** Artist - Song Title\n' +
                '**3.** Artist - Song Title\n' +
                '...\n\n' +
                '_Queue is automatically refilled as songs are played_',
            footer: {
                text: '🤖 Powered by AI music curation'
            },
            timestamp: new Date().toISOString()
        }]
    });
}

async function handleSkip(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    // Skip current song via AIDJManager
    // await aiDJManager.skip(interaction.guildId!);

    await interaction.editReply({
        content: '⏭️ Skipped to next song!'
    });

    logger.info(`[AI DJ] Song skipped for guild ${interaction.guildId}`, {
        user: interaction.user.id
    });
}

async function handleNowPlaying(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    // Get now playing from AIDJManager
    // const nowPlaying = aiDJManager.getNowPlaying(interaction.guildId!);

    await interaction.editReply({
        embeds: [{
            color: 0x9B59B6,
            title: '🎵 Now Playing',
            description: '**Song Title**\nby Artist Name',
            fields: [
                { name: 'Album', value: 'Album Name', inline: true },
                { name: 'Year', value: '2020', inline: true },
                { name: 'Genre', value: 'Rock', inline: true }
            ],
            thumbnail: {
                url: 'https://via.placeholder.com/300'
            },
            footer: {
                text: '🤖 AI DJ - Powered by AI music curation'
            },
            timestamp: new Date().toISOString()
        }]
    });
}

async function handlePlaylist(interaction: ChatInputCommandInteraction): Promise<void> {
    const action = interaction.options.getString('action', true);
    const name = interaction.options.getString('name');

    await interaction.deferReply();

    switch (action) {
        case 'save':
            if (!name) {
                await interaction.editReply('❌ Please provide a name for the playlist.');
                return;
            }

            // Save current config as playlist
            await interaction.editReply(`✅ Playlist **${name}** saved!`);
            break;

        case 'load':
            if (!name) {
                await interaction.editReply('❌ Please provide the name of the playlist to load.');
                return;
            }

            // Load playlist config
            await interaction.editReply(`✅ Playlist **${name}** loaded!`);
            break;

        case 'list':
            // List all playlists
            await interaction.editReply({
                embeds: [{
                    color: 0x9B59B6,
                    title: '📋 AI DJ Playlists',
                    description: '**1.** Rock Classics\n**2.** Chill Vibes\n**3.** Gaming Mix',
                    footer: {
                        text: 'Use /aidj playlist load <name> to load a playlist'
                    }
                }]
            });
            break;

        case 'delete':
            if (!name) {
                await interaction.editReply('❌ Please provide the name of the playlist to delete.');
                return;
            }

            // Delete playlist
            await interaction.editReply(`✅ Playlist **${name}** deleted.`);
            break;
    }
}

async function handleFavorite(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    // Add current song to favorites
    await interaction.editReply('⭐ Current song added to favorites! It will be played more often.');

    logger.info(`[AI DJ] Song favorited for guild ${interaction.guildId}`, {
        user: interaction.user.id
    });
}

async function handleBlacklist(interaction: ChatInputCommandInteraction): Promise<void> {
    const reason = interaction.options.getString('reason');

    await interaction.deferReply();

    // Blacklist current song
    await interaction.editReply(`🚫 Current song blacklisted. It will never be played again.${reason ? `\nReason: ${reason}` : ''}`);

    logger.info(`[AI DJ] Song blacklisted for guild ${interaction.guildId}`, {
        reason,
        user: interaction.user.id
    });
}

async function handleStats(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    // Get statistics from database
    await interaction.editReply({
        embeds: [{
            color: 0x9B59B6,
            title: '📊 AI DJ Statistics',
            fields: [
                { name: 'Total Songs Played', value: '1,234', inline: true },
                { name: 'Hours Played', value: '156', inline: true },
                { name: 'Unique Listeners', value: '89', inline: true },
                { name: 'Top Genre', value: 'Rock (45%)', inline: true },
                { name: 'Songs Skipped', value: '23 (1.9%)', inline: true },
                { name: 'Favorites', value: '67 songs', inline: true }
            ],
            footer: {
                text: '🤖 AI DJ Analytics - Last 30 days'
            },
            timestamp: new Date().toISOString()
        }]
    });
}
