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
    PermissionsBitField,
    Role,
    Collection
} from "discord.js";
import db from "../../utils/db";
import logger from "../../utils/logger";


export async function handleRep(interaction: any): Promise<any> {
    const guildId = interaction.guild.id;

    const [leaderboard] = await db.execute(
        "SELECT user_id, rep_points FROM reputation WHERE guild_id = ? AND rep_points > 0 ORDER BY rep_points DESC LIMIT 10",
        [guildId]
    );

    if (leaderboard.length === 0) {
        return interaction.editReply("No one has any reputation points yet!");
    }

    const description = leaderboard.map((entry, index) => {
        return `${index + 1}. <@${entry.user_id}> - **${entry.rep_points}** points`;
    }).join("\n");

    const embed = new EmbedBuilder()
        .setTitle(`⭐ Reputation Leaderboard`)
        .setColor("#F1C40F")
        .setDescription(description);

    await interaction.editReply({ embeds: [embed] });
}

export async function handleXp(interaction: any): Promise<any> {
    const guildId = interaction.guild.id;

    const [leaderboard] = await db.execute(
        "SELECT user_id, level, xp FROM user_levels WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT 10",
        [guildId]
    );

    if (leaderboard.length === 0) {
        return interaction.editReply("No one has earned any XP yet!");
    }

    const description = leaderboard.map((entry, index) => {
        return `${index + 1}. <@${entry.user_id}> - Level **${entry.level}** (${entry.xp} XP)`;
    }).join("\n");

    const embed = new EmbedBuilder()
        .setTitle(`📊 XP Leaderboard`)
        .setColor("#5865F2")
        .setDescription(description);

    await interaction.editReply({ embeds: [embed] });
}

module.exports = {
    handleRep,
    handleXp
};
