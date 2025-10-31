"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCreate = handleCreate;
exports.handleDelete = handleDelete;
exports.handleAdd = handleAdd;
exports.handleRemove = handleRemove;
exports.handleList = handleList;
exports.handleShow = handleShow;
exports.handlePlay = handlePlay;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../../utils/db"));
/**
 * Handles creating a new playlist
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleCreate(interaction) {
    const name = interaction.options.getString("name");
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    try {
        await db_1.default.execute("INSERT INTO user_playlists (guild_id, user_id, name, songs) VALUES (?,?,?,?)", [guildId, userId, name, "[]"]);
        return interaction.reply({ content: `✅ Playlist **${name}** created.`, ephemeral: true });
    }
    catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            return interaction.reply({ content: `❌ You already have a playlist named **${name}**.`, ephemeral: true });
        }
        console.error("[Playlist Create Error]", error.message);
        return interaction.reply({ content: "❌ An error occurred while creating the playlist.", ephemeral: true });
    }
}
/**
 * Handles deleting a playlist
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleDelete(interaction) {
    const name = interaction.options.getString("name");
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    try {
        const [result] = await db_1.default.execute("DELETE FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
        if (result.affectedRows > 0) {
            return interaction.reply({ content: `🗑️ Playlist **${name}** deleted.`, ephemeral: true });
        }
        else {
            return interaction.reply({ content: `❌ You don't have a playlist named **${name}**.`, ephemeral: true });
        }
    }
    catch (error) {
        console.error("[Playlist Delete Error]", error.message);
        return interaction.reply({ content: "❌ An error occurred while deleting the playlist.", ephemeral: true });
    }
}
/**
 * Handles adding the current song to a playlist
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleAdd(interaction) {
    const name = interaction.options.getString("name");
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const queue = interaction.client.player.nodes.get(guildId);
    if (!queue || !queue.isPlaying()) {
        return interaction.reply({ content: "There is nothing playing to add!", ephemeral: true });
    }
    const currentTrack = queue.currentTrack;
    try {
        const [[playlist]] = await db_1.default.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
        if (!playlist) {
            return interaction.reply({ content: `❌ You don't have a playlist named **${name}**.`, ephemeral: true });
        }
        const songs = JSON.parse(playlist.songs);
        songs.push({ title: currentTrack.title, url: currentTrack.url });
        await db_1.default.execute("UPDATE user_playlists SET songs = ? WHERE playlist_id = ?", [JSON.stringify(songs), playlist.playlist_id]);
        return interaction.reply({ content: `✅ Added **${currentTrack.title}** to the **${name}** playlist.`, ephemeral: true });
    }
    catch (error) {
        console.error("[Playlist Add Error]", error.message);
        return interaction.reply({ content: "❌ An error occurred while adding to the playlist.", ephemeral: true });
    }
}
/**
 * Handles removing a song from a playlist
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleRemove(interaction) {
    const name = interaction.options.getString("name");
    const position = interaction.options.getInteger("position") - 1;
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    try {
        const [[playlist]] = await db_1.default.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
        if (!playlist) {
            return interaction.reply({ content: `❌ You don't have a playlist named **${name}**.`, ephemeral: true });
        }
        const songs = JSON.parse(playlist.songs);
        if (position < 0 || position >= songs.length) {
            return interaction.reply({ content: "❌ Invalid song position.", ephemeral: true });
        }
        const removedSong = songs.splice(position, 1)[0];
        await db_1.default.execute("UPDATE user_playlists SET songs = ? WHERE playlist_id = ?", [JSON.stringify(songs), playlist.playlist_id]);
        return interaction.reply({ content: `🗑️ Removed **${removedSong.title}** from the **${name}** playlist.`, ephemeral: true });
    }
    catch (error) {
        console.error("[Playlist Remove Error]", error.message);
        return interaction.reply({ content: "❌ An error occurred while removing from the playlist.", ephemeral: true });
    }
}
/**
 * Handles listing all playlists
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleList(interaction) {
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    try {
        const [playlists] = await db_1.default.execute("SELECT name FROM user_playlists WHERE guild_id = ? AND user_id = ?", [guildId, userId]);
        if (playlists.length === 0) {
            return interaction.reply({ content: "You don't have any playlists yet.", ephemeral: true });
        }
        const embed = new discord_js_1.EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({ name: "Your Playlists" })
            .setDescription(playlists.map(p => `• ${p.name}`).join("\n"));
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    catch (error) {
        console.error("[Playlist List Error]", error.message);
        return interaction.reply({ content: "❌ An error occurred while listing playlists.", ephemeral: true });
    }
}
/**
 * Handles showing songs in a playlist
 * @param {Interaction} interaction - Discord interaction object
 */
async function handleShow(interaction) {
    const name = interaction.options.getString("name");
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    try {
        const [[playlist]] = await db_1.default.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
        if (!playlist) {
            return interaction.reply({ content: `❌ You don't have a playlist named **${name}**.`, ephemeral: true });
        }
        const songs = JSON.parse(playlist.songs);
        const embed = new discord_js_1.EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({ name: `Playlist: ${name}` })
            .setDescription(songs.length > 0 ? songs.map((s, i) => `**${i + 1}.** ${s.title}`).join("\n") : "This playlist is empty.");
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    catch (error) {
        console.error("[Playlist Show Error]", error.message);
        return interaction.reply({ content: "❌ An error occurred while showing the playlist.", ephemeral: true });
    }
}
/**
 * Handles playing a playlist
 * @param {Interaction} interaction - Discord interaction object
 */
async function handlePlay(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }
    if (!interaction.member.voice.channel) {
        return interaction.reply({ content: "You must be in a voice channel to play music!", ephemeral: true });
    }
    const name = interaction.options.getString("name");
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    try {
        const [[playlist]] = await db_1.default.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
        if (!playlist) {
            return interaction.reply({ content: `❌ You don't have a playlist named **${name}**.`, ephemeral: true });
        }
        const songs = JSON.parse(playlist.songs);
        if (songs.length === 0) {
            return interaction.reply({ content: `The **${name}** playlist is empty.`, ephemeral: true });
        }
        await interaction.deferReply();
        try {
            await interaction.client.player.play(interaction.member.voice.channel, songs.map(s => s.url).join("\n"), {
                requestedBy: interaction.user,
                nodeOptions: {
                    metadata: { channelId: interaction.channel.id }
                }
            });
            return interaction.followUp({ content: `▶️ Now playing the **${name}** playlist.` });
        }
        catch (e) {
            console.error("[Playlist Play Error]", e.message);
            return interaction.followUp({ content: `❌ An error occurred while trying to play the playlist: ${e.message}` });
        }
    }
    catch (error) {
        console.error("[Playlist Play Error]", error.message);
        return interaction.reply({ content: "❌ An error occurred while playing the playlist.", ephemeral: true });
    }
}
module.exports = {
    handleCreate,
    handleDelete,
    handleAdd,
    handleRemove,
    handleList,
    handleShow,
    handlePlay,
};
