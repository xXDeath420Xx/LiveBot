"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleGive = handleGive;
exports.handleCheck = handleCheck;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../../utils/db"));
const REP_COOLDOWN_HOURS = 24;
async function handleGive(interaction) {
    const targetUser = interaction.options.getUser("user");
    const giverUser = interaction.user;
    const guildId = interaction.guild.id;
    if (targetUser.id === giverUser.id) {
        return interaction.editReply({ content: "You can't give reputation to yourself.", ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.editReply({ content: "You can't give reputation to a bot.", ephemeral: true });
    }
    const [[giverRep]] = await db_1.default.execute("SELECT last_rep_timestamp FROM reputation WHERE guild_id = ? AND user_id = ?", [guildId, giverUser.id]);
    if (giverRep && giverRep.last_rep_timestamp) {
        const cooldownEnd = new Date(giverRep.last_rep_timestamp).getTime() + (REP_COOLDOWN_HOURS * 60 * 60 * 1000);
        if (Date.now() < cooldownEnd) {
            return interaction.editReply({
                content: `You can give reputation again <t:${Math.floor(cooldownEnd / 1000)}:R>.`,
                ephemeral: true
            });
        }
    }
    // Add rep point to target
    await db_1.default.execute("INSERT INTO reputation (guild_id, user_id, rep_points) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE rep_points = rep_points + 1", [guildId, targetUser.id]);
    // Update giver's timestamp
    await db_1.default.execute("INSERT INTO reputation (guild_id, user_id, last_rep_timestamp) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE last_rep_timestamp = NOW()", [guildId, giverUser.id]);
    await interaction.editReply(`${giverUser.username} has given a reputation point to ${targetUser.username}!`);
}
async function handleCheck(interaction) {
    const targetUser = interaction.options.getUser("user") || interaction.user;
    const guildId = interaction.guild.id;
    const [[rep]] = await db_1.default.execute("SELECT rep_points FROM reputation WHERE guild_id = ? AND user_id = ?", [guildId, targetUser.id]);
    const points = rep ? rep.rep_points : 0;
    const embed = new discord_js_1.EmbedBuilder()
        .setColor("#F1C40F")
        .setAuthor({ name: targetUser.username, iconURL: targetUser.displayAvatarURL() })
        .setDescription(`⭐ **${points}** reputation points.`);
    await interaction.editReply({ embeds: [embed] });
}
module.exports = {
    handleGive,
    handleCheck
};
