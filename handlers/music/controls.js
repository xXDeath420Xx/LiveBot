import { QueueRepeatMode } from 'discord-player';
import { EmbedBuilder, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { checkMusicPermissions, updateMusicConfig, getMusicConfig, isVoteSkipEnabled, getVoteSkipPercentage } from '../../utils/music_helpers.js';
import { manageLeave, leaveIfIdle } from '../../core/music-leave-policy.js';
import { rejoinCamp } from '../../core/voice-camp-manager.js';
import { isVoiceChannelType } from '../../core/voice-camp-helpers.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { findFilter, filterLabel, allowedFilterNames, isFilterAllowed, offeredFilters } from '../../core/music-filters.js';

// Active vote skip sessions
const activeVoteSkips = new Map();

// Helper function to convert time strings to milliseconds
export function toMilliseconds(timeString) {
    const timeRegex = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
    const matches = timeString.match(timeRegex);
    if (!matches) return 0;
    const hours = parseInt(matches[1], 10) || 0;
    const minutes = parseInt(matches[2], 10) || 0;
    const seconds = parseInt(matches[3], 10) || 0;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * Handles adjusting playback volume
 */
export async function handleVolume(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    const volume = interaction.options.getInteger("level");

    try {
        queue.node.setVolume(volume);
        await interaction.reply({ content: `Volume set to **${volume}%**.` });
    } catch (e) {
        await interaction.reply({ content: `Error: ${e.message}` });
    }
}

/**
 * Handles setting the loop mode
 */
export async function handleLoop(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    const loopMode = interaction.options.getInteger("mode");

    try {
        queue.setRepeatMode(loopMode);
        const modeName = Object.keys(QueueRepeatMode).find(key => QueueRepeatMode[key] === loopMode);
        await interaction.reply({ content: `Loop mode set to **${modeName}**.` });
    } catch (e) {
        await interaction.reply({ content: `Error: ${e.message}` });
    }
}

/**
 * Handles applying or removing audio filters
 */
export async function handleFilter(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    const filterName = interaction.options.getString("filter");
    const action = interaction.options.getString("action");
    const want = action === "enable";

    // The option autocompletes, so anything can be typed: only known filters are applied.
    const filter = findFilter(filterName);
    if (!filter) {
        return interaction.reply({ content: `There is no filter called **${String(filterName).slice(0, 50)}**. Pick one from the list.`, ephemeral: true, allowedMentions: { parse: [] } });
    }
    // The Music page's allow-list (music_config.enabled_filters; none ticked = all). Turning a filter
    // off is always allowed, so one left on from before a restriction can still be removed.
    if (want) {
        const allowed = allowedFilterNames((await getMusicConfig(interaction.guildId))?.enabled_filters);
        if (!isFilterAllowed(filter.value, allowed)) {
            return interaction.reply({
                content: `The **${filter.label}** filter is not allowed in this server. Allowed filters: ${offeredFilters(allowed).map(f => f.label).join(', ')}. Admins choose them on the dashboard's Music page.`,
                ephemeral: true,
            });
        }
    }

    try {
        // toggle() FLIPS the state — only call it when the filter isn't already where the user
        // asked, or "enable" on an enabled filter would turn it off.
        const ff = queue.filters.ffmpeg;
        if (ff.isEnabled(filter.value) !== want) await ff.toggle(filter.value);
        await interaction.reply({ content: `**${filter.label}** filter ${want ? "enabled" : "disabled"}.` });
    } catch (e) {
        await interaction.reply({ content: `Error: ${e.message}` });
    }
}

/**
 * Handles seeking to a specific time in the current song
 */
export async function handleSeek(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    const timeString = interaction.options.getString("time");
    const timeMs = toMilliseconds(timeString);

    if (timeMs <= 0) {
        return interaction.reply({ content: "Invalid time format. Use format like `1m30s`, `2h`, `45s`.", ephemeral: true });
    }

    try {
        await queue.node.seek(timeMs);
        await interaction.reply({ content: `Seeked to **${timeString}**.` });
    } catch (e) {
        await interaction.reply({ content: `Error: ${e.message}` });
    }
}

/**
 * Handles 24/7 mode toggle
 */
export async function handle247(interaction) {
    // Check if user has admin permissions
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permissions to toggle 24/7 mode.', ephemeral: true });
    }

    const toggle = interaction.options.getString('toggle');
    const enabled = toggle === 'on';

    try {
        await updateMusicConfig(interaction.guildId, { twenty_four_seven: enabled ? 1 : 0 });

        // core/music-leave-policy.js reads 24/7 each time it decides, so enabling needs nothing more.
        // Disabling while idle leaves now — unless a transcription, the chat reader or camp still needs voice.
        const player = interaction.client.player;
        const queue = player.nodes.get(interaction.guildId);
        if (queue) {
            manageLeave(queue);
            if (!enabled) {
                await leaveIfIdle(queue, { reason: '24/7 turned off while idle', player });
            }
        }

        const embed = new EmbedBuilder()
            .setColor(enabled ? '#00ff00' : '#ff0000')
            .setTitle('24/7 Mode')
            .setDescription(enabled
                ? '24/7 mode is now **enabled**. The bot will stay in the voice channel even when the queue is empty.'
                : '24/7 mode is now **disabled**. The bot will leave the voice channel when the queue is empty.')
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        logger.info(`[24/7] ${enabled ? 'Enabled' : 'Disabled'} for guild ${interaction.guildId} by ${interaction.user.tag}`);
    } catch (error) {
        logger.error(`[24/7] Error: ${error.message}`);
        await interaction.reply({ content: `Failed to update 24/7 mode: ${error.message}`, ephemeral: true });
    }
}

/**
 * Handles the camp ("always stay") voice channel setting.
 * /music settings camp channel:<voice channel>  -> set + join
 * /music settings camp off                       -> clear
 */
export async function handleCamp(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permissions to configure the camp channel.', ephemeral: true });
    }

    const channel = interaction.options.getChannel('channel'); // null => disable

    try {
        if (!channel) {
            await updateMusicConfig(interaction.guildId, { default_voice_channel_id: null });
            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('Camp Channel')
                .setDescription('Camp mode is now **disabled**. The bot will no longer be forced to stay in a voice channel.')
                .setTimestamp();
            logger.info(`[Camp] Disabled for guild ${interaction.guildId} by ${interaction.user.tag}`);
            return interaction.reply({ embeds: [embed] });
        }

        if (!isVoiceChannelType(channel.type)) {
            return interaction.reply({ content: 'Please select a voice channel.', ephemeral: true });
        }

        await updateMusicConfig(interaction.guildId, { default_voice_channel_id: channel.id });
        await rejoinCamp(interaction.client, interaction.client.player, interaction.guildId);

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('Camp Channel')
            .setDescription(`Camp mode is now **enabled** for ${channel}. The bot will stay there and return after playing music.`)
            .setTimestamp();
        logger.info(`[Camp] Set to ${channel.id} for guild ${interaction.guildId} by ${interaction.user.tag}`);
        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        logger.error(`[Camp] Error: ${error.message}`);
        await interaction.reply({ content: `Failed to update camp channel: ${error.message}`, ephemeral: true });
    }
}

/**
 * Handles autoplay toggle
 */
export async function handleAutoplay(interaction) {
    // Check if user has admin permissions or DJ role
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const mode = interaction.options.getString('mode');
    const enabled = mode !== 'off';
    const source = mode === 'off' ? 'youtube' : mode;

    try {
        await updateMusicConfig(interaction.guildId, {
            autoplay_enabled: enabled ? 1 : 0,
            autoplay_source: source
        });

        const embed = new EmbedBuilder()
            .setColor(enabled ? '#00ff00' : '#ff0000')
            .setTitle('Autoplay')
            .setDescription(enabled
                ? `Autoplay is now **enabled** using **${source === 'ai' ? 'AI recommendations' : 'YouTube'}**.\nWhen the queue ends, similar songs will be automatically added.`
                : 'Autoplay is now **disabled**.')
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        logger.info(`[Autoplay] Set to ${mode} for guild ${interaction.guildId} by ${interaction.user.tag}`);
    } catch (error) {
        logger.error(`[Autoplay] Error: ${error.message}`);
        await interaction.reply({ content: `Failed to update autoplay: ${error.message}`, ephemeral: true });
    }
}

/**
 * Handles request channel configuration
 */
export async function handleRequestChannel(interaction) {
    // Check if user has admin permissions
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permissions to configure the request channel.', ephemeral: true });
    }

    const channel = interaction.options.getChannel('channel');

    try {
        if (channel) {
            // Verify it's a text channel
            if (channel.type !== ChannelType.GuildText) {
                return interaction.reply({ content: 'Please select a text channel.', ephemeral: true });
            }

            await updateMusicConfig(interaction.guildId, { request_channel_id: channel.id });

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Song Request Channel')
                .setDescription(`Song request channel set to ${channel}.\n\nAny message sent in this channel will be treated as a song request and automatically added to the queue.`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
            logger.info(`[Request Channel] Set to ${channel.id} for guild ${interaction.guildId}`);
        } else {
            // Disable request channel
            await updateMusicConfig(interaction.guildId, { request_channel_id: null });

            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('Song Request Channel')
                .setDescription('Song request channel has been disabled.')
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
            logger.info(`[Request Channel] Disabled for guild ${interaction.guildId}`);
        }
    } catch (error) {
        logger.error(`[Request Channel] Error: ${error.message}`);
        await interaction.reply({ content: `Failed to update request channel: ${error.message}`, ephemeral: true });
    }
}

/**
 * Handles vote skip
 */
export async function handleVoteSkip(interaction) {
    // Any listener may start a vote, DJ role or not (H-667); the vote itself decides.
    const permissionCheck = await checkMusicPermissions(interaction, { requireDJ: false });
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    // Check if vote skip is enabled
    const voteSkipEnabled = await isVoteSkipEnabled(interaction.guildId);
    if (!voteSkipEnabled) {
        // If vote skip not enabled, just do a regular skip
        return interaction.reply({ content: 'Vote skip is not enabled. Use `/music skip` instead.', ephemeral: true });
    }

    // Check if there's already an active vote
    if (activeVoteSkips.has(interaction.guildId)) {
        return interaction.reply({ content: 'There is already an active vote skip. Please vote on that one!', ephemeral: true });
    }

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
        return interaction.reply({ content: 'You need to be in a voice channel to vote skip.', ephemeral: true });
    }

    // Get required percentage
    const percentage = await getVoteSkipPercentage(interaction.guildId);

    // Count listeners (excluding bots)
    const listeners = voiceChannel.members.filter(m => !m.user.bot).size;
    const requiredVotes = Math.ceil(listeners * (percentage / 100));

    // Track votes
    const votes = new Set([interaction.user.id]);

    const currentTrack = queue.currentTrack;

    const embed = new EmbedBuilder()
        .setColor('#ffaa00')
        .setTitle('Vote Skip')
        .setDescription(`**${interaction.user}** wants to skip **${currentTrack.title}**\n\nVotes: **${votes.size}/${requiredVotes}** (${percentage}% of listeners required)`)
        .setThumbnail(currentTrack.thumbnail)
        .setFooter({ text: 'Vote expires in 30 seconds' })
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('voteskip_yes')
                .setLabel(`Skip (${votes.size}/${requiredVotes})`)
                .setStyle(ButtonStyle.Success)
                .setEmoji('⏭️'),
            new ButtonBuilder()
                .setCustomId('voteskip_no')
                .setLabel('Keep Playing')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🎵')
        );

    const message = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });

    // Store vote session
    activeVoteSkips.set(interaction.guildId, {
        votes,
        requiredVotes,
        message,
        track: currentTrack.title
    });

    // Set up collector
    const collector = message.createMessageComponentCollector({ time: 30000 });
    // A lone listener (or a low threshold) has already passed — don't make them wait 30s.
    if (votes.size >= requiredVotes) collector.stop('skipped');

    collector.on('collect', async (i) => {
        if (i.customId === 'voteskip_yes') {
            // Check if user is in voice channel
            if (!i.member.voice.channel || i.member.voice.channel.id !== voiceChannel.id) {
                return i.reply({ content: 'You need to be in the voice channel to vote.', ephemeral: true });
            }

            votes.add(i.user.id);

            // Check if enough votes
            if (votes.size >= requiredVotes) {
                collector.stop('skipped');
                return;
            }

            // Update embed
            embed.setDescription(`**${interaction.user}** wants to skip **${currentTrack.title}**\n\nVotes: **${votes.size}/${requiredVotes}** (${percentage}% of listeners required)`);
            row.components[0].setLabel(`Skip (${votes.size}/${requiredVotes})`);

            await i.update({ embeds: [embed], components: [row] });
        } else if (i.customId === 'voteskip_no') {
            await i.reply({ content: 'You chose to keep the song playing!', ephemeral: true });
        }
    });

    collector.on('end', async (_, reason) => {
        activeVoteSkips.delete(interaction.guildId);

        if (reason === 'skipped' || votes.size >= requiredVotes) {
            // Skip the song — but only if it's still the one voted on. If it ended during the
            // vote, skipping now would throw out the NEXT song.
            try {
                if (queue.currentTrack?.id === currentTrack.id) queue.node.skip();
                embed.setColor('#00ff00')
                    .setDescription(`Vote passed! Skipping **${currentTrack.title}**`)
                    .setFooter({ text: `Skipped with ${votes.size}/${requiredVotes} votes` });
            } catch (e) {
                embed.setColor('#ff0000')
                    .setDescription(`Failed to skip: ${e.message}`);
            }
        } else {
            embed.setColor('#ff0000')
                .setDescription(`Vote skip failed. Not enough votes (${votes.size}/${requiredVotes}).\nKeeping **${currentTrack.title}** playing.`);
        }

        row.components.forEach(c => c.setDisabled(true));
        await message.edit({ embeds: [embed], components: [row] }).catch(() => {});
    });
}

/**
 * Handles force skip (DJ/Admin only)
 */
export async function handleForceSkip(interaction) {
    // Check for DJ role or Admin
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const config = await getMusicConfig(interaction.guildId);
    const isDJ = config?.dj_role_id && interaction.member.roles.cache.has(config.dj_role_id);
    const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
    let isBotOwner = false;
    try { const { isSuperAdmin } = await import('../../utils/constants.js'); isBotOwner = isSuperAdmin(interaction.member.id); } catch {}

    if (!isDJ && !isAdmin && !isBotOwner) {
        return interaction.reply({ content: 'You need the DJ role or Administrator permissions to force skip.', ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    const currentTrack = queue.currentTrack;

    try {
        queue.node.skip();
        await interaction.reply({ content: `Force skipped **${currentTrack.title}**.` });
        logger.info(`[Force Skip] ${interaction.user.tag} force skipped "${currentTrack.title}" in guild ${interaction.guildId}`);
    } catch (e) {
        await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
    }
}

/**
 * Handles equalizer presets
 */
export async function handleEqualizer(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    const preset = interaction.options.getString('preset');

    // Define FFmpeg filter configurations for each preset
    const presets = {
        flat: { filters: [], description: 'No equalizer effects' },
        bass: {
            filters: ['bassboost'],
            description: 'Enhanced bass frequencies'
        },
        treble: {
            filters: ['treble'],
            description: 'Enhanced high frequencies'
        },
        pop: {
            filters: ['normalizer'],
            description: 'Balanced for pop music'
        },
        rock: {
            filters: ['bassboost', 'treble'],
            description: 'Enhanced bass and treble for rock'
        },
        electronic: {
            filters: ['bassboost', 'nightcore'],
            description: 'Deep bass with slight speed boost'
        },
        soft: {
            filters: ['normalizer', 'vaporwave'],
            description: 'Gentle and relaxed sound'
        },
        karaoke: {
            filters: ['karaoke'],
            description: 'Reduces vocal frequencies'
        }
    };

    const selectedPreset = presets[preset];
    if (!selectedPreset) {
        return interaction.reply({ content: 'Invalid preset.', ephemeral: true });
    }

    // A preset is a set of filters, so the Music page's allow-list applies to it too ('flat' has none).
    const allowedForEq = allowedFilterNames((await getMusicConfig(interaction.guildId))?.enabled_filters);
    const blockedForEq = selectedPreset.filters.filter(name => !isFilterAllowed(name, allowedForEq));
    if (blockedForEq.length) {
        return interaction.reply({
            content: `The **${preset}** preset uses ${blockedForEq.map(filterLabel).join(' and ')}, which ${blockedForEq.length === 1 ? 'is' : 'are'} not allowed in this server. Admins choose the allowed filters on the dashboard's Music page.`,
            ephemeral: true,
        });
    }

    try {
        // One call replaces the whole set. Clearing then toggling each filter un-awaited fired a
        // separate stream replay per filter, all racing each other.
        await queue.filters.ffmpeg.setFilters(selectedPreset.filters);

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('Equalizer Preset Applied')
            .setDescription(`**${preset.charAt(0).toUpperCase() + preset.slice(1)}** preset applied.\n\n${selectedPreset.description}`)
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        logger.info(`[EQ] Applied "${preset}" preset in guild ${interaction.guildId}`);
    } catch (e) {
        await interaction.reply({ content: `Error applying preset: ${e.message}`, ephemeral: true });
    }
}

/**
 * Handles vote skip settings configuration
 */
export async function handleVoteSkipSettings(interaction) {
    // Check if user has admin permissions
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permissions to configure vote skip settings.', ephemeral: true });
    }

    const enabled = interaction.options.getString('enabled');
    const percentage = interaction.options.getInteger('percentage');

    const updates = {};
    const changes = [];

    if (enabled !== null) {
        updates.vote_skip_enabled = enabled === 'on' ? 1 : 0;
        changes.push(`Vote skip: **${enabled === 'on' ? 'Enabled' : 'Disabled'}**`);
    }

    if (percentage !== null) {
        updates.vote_skip_percentage = percentage;
        changes.push(`Skip threshold: **${percentage}%** of listeners`);
    }

    if (Object.keys(updates).length === 0) {
        // Show current settings
        const config = await getMusicConfig(interaction.guildId);
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('Vote Skip Settings')
            .addFields(
                { name: 'Status', value: config?.vote_skip_enabled ? 'Enabled' : 'Disabled', inline: true },
                { name: 'Threshold', value: `${config?.vote_skip_percentage || 50}%`, inline: true }
            )
            .setDescription('Use the command options to modify these settings.')
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    try {
        await updateMusicConfig(interaction.guildId, updates);

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('Vote Skip Settings Updated')
            .setDescription(changes.join('\n'))
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        logger.info(`[Vote Skip] Settings updated for guild ${interaction.guildId}: ${JSON.stringify(updates)}`);
    } catch (error) {
        logger.error(`[Vote Skip] Error: ${error.message}`);
        await interaction.reply({ content: `Failed to update settings: ${error.message}`, ephemeral: true });
    }
}
