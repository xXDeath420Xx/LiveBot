import { 
    EmbedBuilder, 
    ChatInputCommandInteraction, 
    Message, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    StringSelectMenuBuilder,
    User,
    TextChannel,
    Client,
    Guild,
    GuildMember,
    VoiceChannel,
    StageChannel,
    Collection
} from "discord.js";
import db from "../../utils/db";
import logger from "../../utils/logger";


/**
 * Handles playing a song or playlist
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handlePlay(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    if (!interaction.member.voice.channel) {
        return interaction.reply({ content: "You must be in a voice channel to play music!", ephemeral: true });
    }

    await interaction.deferReply();
    const player = useMainPlayer();
    const query = interaction.options.getString("query");

    try {
        const searchResult = await player.search(query, { requestedBy: interaction.user });
        if (!searchResult.hasTracks()) {
            return interaction.editReply({ content: `❌ | No results found for your query: ${query}` });
        }

        if (searchResult.playlist) {
            searchResult.tracks = searchResult.tracks.filter(t => !t.url.includes('youtube.com/shorts'));
            if (searchResult.tracks.length === 0) {
                return interaction.editReply({ content: `❌ | All tracks in the playlist were YouTube Shorts, which are not supported.` });
            }
        } else {
            if (searchResult.tracks[0].url.includes('youtube.com/shorts')) {
                return interaction.editReply({ content: `❌ | The requested track is a YouTube Short, which is not supported.` });
            }
        }

        const { track } = await player.play(interaction.member.voice.channel, searchResult, {
            nodeOptions: {
                metadata: {
                    channelId: interaction.channel.id,
                    djMode: false,
                    voiceChannelId: interaction.member.voice.channel.id
                },
                selfDeaf: true,
                volume: 80,
                leaveOnEmpty: true,
                leaveOnEmptyCooldown: 300000,
                leaveOnEnd: true,
                leaveOnEndCooldown: 300000,
            }
        });

        const replyMessage = track.playlist
            ? `✅ | Added **${track.playlist.tracks.length}** valid tracks from the playlist to the queue.`
            : `✅ | Added **${track.title}** to the queue.`;

        return interaction.editReply({ content: replyMessage });
    } catch (e) {
        if (e.message.includes("No results found")) {
            return interaction.editReply({ content: `❌ | No results found for your query: ${query}` });
        }
        console.error("[Play Command Error]", e.message);
        return interaction.editReply({ content: `An error occurred: ${e.message}` });
    }
}

/**
 * Handles pausing the music
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handlePause(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    if (queue.node.isPaused()) {
        return interaction.reply({ content: "The music is already paused!", ephemeral: true });
    }

    try {
        queue.node.setPaused(true);
        await interaction.reply({ content: "⏸️ Paused the music." });
    } catch (e) {
        await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
}

/**
 * Handles resuming the music
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleResume(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    if (!queue.node.isPaused()) {
        return interaction.reply({ content: "The music is not paused!", ephemeral: true });
    }

    try {
        queue.node.setPaused(false);
        await interaction.reply({ content: "▶️ Resumed the music." });
    } catch (e) {
        await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
}

/**
 * Handles skipping the current song
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleSkip(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing to skip!", ephemeral: true });
    }

    const skippedTrack = queue.currentTrack;
    const isLastTrack = queue.tracks.size === 0;

    await interaction.deferReply();

    if (queue.metadata.djMode) {
        await interaction.client.djManager.playSkipBanter(queue, skippedTrack, interaction.user);
    }

    const success = queue.node.skip();
    if (!success) {
        return interaction.editReply({ content: "❌ Something went wrong while skipping." });
    }

    if (isLastTrack && queue.metadata.djMode) {
        await interaction.client.djManager.onQueueEnd(queue);
    }

    return interaction.editReply({ content: "⏭️ Skipped! Now playing the next song." });
}

/**
 * Handles stopping the music and clearing the queue
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleStop(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    try {
        queue.delete();
        await interaction.reply({ content: "⏹️ Music stopped and queue cleared." });
    } catch (e) {
        await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
}

/**
 * Handles displaying information about the currently playing song
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleNowPlaying(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    const track = queue.currentTrack;
    if (!track) {
        return interaction.reply({ content: "There is nothing playing right now!", ephemeral: true });
    }

    const progress = queue.node.createProgressBar();

    let requesterTag = 'Unknown User';
    if (track.requestedBy && track.requestedBy.id !== interaction.client.user.id) {
        requesterTag = track.requestedBy.tag;
    } else if (queue.metadata?.djMode && queue.metadata?.djInitiatorId) {
        try {
            const djUser = await interaction.client.users.fetch(queue.metadata.djInitiatorId);
            requesterTag = djUser.tag;
        } catch (error) {
            // Ignore if user fetch fails
        }
    }

    const embed = new EmbedBuilder()
        .setColor("#57F287")
        .setAuthor({ name: "Now Playing" })
        .setTitle(track.title || "Unknown Title")
        .setURL(track.url || null)
        .setThumbnail(track.thumbnail || null)
        .addFields(
            { name: "Artist", value: track.author || "N/A", inline: true },
            { name: "Duration", value: track.duration || "0:00", inline: true },
            { name: "Requested by", value: requesterTag, inline: true },
            { name: "Progress", value: progress, inline: false }
        );

    await interaction.reply({ embeds: [embed] });
}

module.exports = {
    handlePlay,
    handlePause,
    handleResume,
    handleSkip,
    handleStop,
    handleNowPlaying,
};
