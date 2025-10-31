"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toMilliseconds = toMilliseconds;
exports.handleVolume = handleVolume;
exports.handleLoop = handleLoop;
exports.handleFilter = handleFilter;
exports.handleSeek = handleSeek;
// Helper function to convert time strings to milliseconds
function toMilliseconds(timeString) {
    const timeRegex = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
    const matches = timeString.match(timeRegex);
    if (!matches)
        return 0;
    const hours = parseInt(matches[1], 10) || 0;
    const minutes = parseInt(matches[2], 10) || 0;
    const seconds = parseInt(matches[3], 10) || 0;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
}
/**
 * Handles adjusting playback volume
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleVolume(interaction) {
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
        await interaction.reply({ content: `🔊 Volume set to **${volume}%**.` });
    }
    catch (e) {
        await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
}
/**
 * Handles setting the loop mode
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleLoop(interaction) {
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
        await interaction.reply({ content: `🔄 Loop mode set to **${modeName}**.` });
    }
    catch (e) {
        await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
}
/**
 * Handles applying or removing audio filters
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleFilter(interaction) {
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
    try {
        if (action === "enable") {
            queue.filters.ffmpeg.toggle(filterName);
            await interaction.reply({ content: `✅ **${filterName}** filter enabled.` });
        }
        else {
            queue.filters.ffmpeg.toggle(filterName);
            await interaction.reply({ content: `❌ **${filterName}** filter disabled.` });
        }
    }
    catch (e) {
        await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
}
/**
 * Handles seeking to a specific time in the current song
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleSeek(interaction) {
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
        return interaction.reply({ content: "❌ Invalid time format. Use format like `1m30s`, `2h`, `45s`.", ephemeral: true });
    }
    try {
        await queue.node.seek(timeMs);
        await interaction.reply({ content: `⏩ Seeked to **${timeString}**.` });
    }
    catch (e) {
        await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
}
module.exports = {
    handleVolume,
    handleLoop,
    handleFilter,
    handleSeek,
};
