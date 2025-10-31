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
 * Handles displaying the current music queue
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleQueue(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing in the queue right now!", ephemeral: true });
    }

    const tracks = queue.tracks.toArray();
    const currentTrack = queue.currentTrack;

    if (!currentTrack && tracks.length === 0) {
        return interaction.reply({ content: "The queue is empty.", ephemeral: true });
    }

    const escapeMarkdown = (text) => text.replace(/([\[\]\(\)])/g, '\\$1');

    const djUser = queue.metadata?.djMode && queue.metadata?.djInitiatorId
        ? await interaction.client.users.fetch(queue.metadata.djInitiatorId).catch(() => null)
        : null;

    const trackStrings = tracks.slice(0, 10).map((track, i) => {
        const requester = (track.requestedBy?.id === interaction.client.user.id || !track.requestedBy) && djUser
            ? djUser
            : track.requestedBy;
        const requesterTag = requester ? requester.tag : 'Unknown User';
        return `**${i + 1}.** ${escapeMarkdown(track.title)} - ${requesterTag}`;
    });

    let description = "";
    if (currentTrack) {
        const currentRequester = (currentTrack.requestedBy?.id === interaction.client.user.id || !currentTrack.requestedBy) && djUser
            ? djUser
            : currentTrack.requestedBy;
        const currentRequesterTag = currentRequester ? currentRequester.tag : 'Unknown User';
        description += `**Currently Playing:**\n${escapeMarkdown(currentTrack.title)} - ${currentRequesterTag}\n\n`;
    }

    const queueString = trackStrings.join('\n');
    if (tracks.length > 0) {
        description += `**Up Next:**\n${queueString}`;
    } else if (currentTrack) {
        description += `**Up Next:**\nNothing`;
    }

    const embed = new EmbedBuilder()
        .setColor("#3498DB")
        .setAuthor({ name: "Server Queue" })
        .setDescription(description.substring(0, 4096))
        .setFooter({ text: `Total songs in queue: ${tracks.length}` });

    await interaction.reply({ embeds: [embed] });
}

/**
 * Handles shuffling the queue
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleShuffle(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying() || queue.tracks.size < 2) {
        return interaction.reply({ content: "There are not enough songs in the queue to shuffle!", ephemeral: true });
    }

    try {
        queue.tracks.shuffle();
        await interaction.reply({ content: "🔀 The queue has been shuffled." });
    } catch (e) {
        await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
}

/**
 * Handles clearing all songs from the queue
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleClear(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing in the queue to clear!", ephemeral: true });
    }

    if (queue.tracks.size < 1) {
        return interaction.reply({ content: "The queue is already empty.", ephemeral: true });
    }

    try {
        queue.tracks.clear();
        await interaction.reply({ content: "🗑️ The queue has been cleared." });
    } catch (e) {
        await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
}

/**
 * Handles removing a specific song from the queue
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleRemove(interaction: any): Promise<any> {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing in the queue right now!", ephemeral: true });
    }

    const position = interaction.options.getInteger("track") - 1;
    const tracks = queue.tracks.toArray();

    if (position >= tracks.length) {
        return interaction.reply({ content: "❌ Invalid song position.", ephemeral: true });
    }

    try {
        const removedTrack = queue.node.remove(tracks[position]);
        await interaction.reply({ content: `🗑️ Removed **${removedTrack.title}** from the queue.` });
    } catch (e) {
        await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
}

module.exports = {
    handleQueue,
    handleShuffle,
    handleClear,
    handleRemove,
};
