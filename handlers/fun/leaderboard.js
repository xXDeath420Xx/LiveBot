"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRep = handleRep;
exports.handleXp = handleXp;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../../utils/db"));
async function handleRep(interaction) {
    const guildId = interaction.guild.id;
    const [leaderboard] = await db_1.default.execute("SELECT user_id, rep_points FROM reputation WHERE guild_id = ? AND rep_points > 0 ORDER BY rep_points DESC LIMIT 10", [guildId]);
    if (leaderboard.length === 0) {
        return interaction.editReply("No one has any reputation points yet!");
    }
    const description = leaderboard.map((entry, index) => {
        return `${index + 1}. <@${entry.user_id}> - **${entry.rep_points}** points`;
    }).join("\n");
    const embed = new discord_js_1.EmbedBuilder()
        .setTitle(`⭐ Reputation Leaderboard`)
        .setColor("#F1C40F")
        .setDescription(description);
    await interaction.editReply({ embeds: [embed] });
}
async function handleXp(interaction) {
    const guildId = interaction.guild.id;
    const [leaderboard] = await db_1.default.execute("SELECT user_id, level, xp FROM user_levels WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT 10", [guildId]);
    if (leaderboard.length === 0) {
        return interaction.editReply("No one has earned any XP yet!");
    }
    const description = leaderboard.map((entry, index) => {
        return `${index + 1}. <@${entry.user_id}> - Level **${entry.level}** (${entry.xp} XP)`;
    }).join("\n");
    const embed = new discord_js_1.EmbedBuilder()
        .setTitle(`📊 XP Leaderboard`)
        .setColor("#5865F2")
        .setDescription(description);
    await interaction.editReply({ embeds: [embed] });
}
module.exports = {
    handleRep,
    handleXp
};
