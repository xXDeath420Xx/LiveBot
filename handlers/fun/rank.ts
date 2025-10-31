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


export async function handleRank(interaction: any): Promise<any> {
    const targetUser = interaction.options.getUser("user") || interaction.user;
    const guildId = interaction.guild.id;

    const [[user]] = await db.execute(
        "SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?",
        [guildId, targetUser.id]
    );

    if (!user) {
        return interaction.editReply(`${targetUser.tag} has not earned any XP yet.`);
    }

    const xpForNextLevel = 5 * (user.level ** 2) + 50 * user.level + 100;

    // Fetch rank by ordering users by XP
    const [allUsers] = await db.execute(
        "SELECT user_id FROM user_levels WHERE guild_id = ? ORDER BY level DESC, xp DESC",
        [guildId]
    );
    const rank = allUsers.findIndex(u => u.user_id === targetUser.id) + 1;

    // Fetch next role reward
    const [[nextReward]] = await db.execute(
        "SELECT level, role_id FROM role_rewards WHERE guild_id = ? AND level > ? ORDER BY level ASC LIMIT 1",
        [guildId, user.level]
    );

    const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setAuthor({ name: targetUser.username, iconURL: targetUser.displayAvatarURL() })
        .setTitle(`Rank #${rank}`)
        .addFields(
            { name: "Level", value: `**${user.level}**`, inline: true },
            { name: "XP", value: `**${user.xp} / ${xpForNextLevel}**`, inline: true }
        );

    if (nextReward) {
        embed.addFields({ name: "Next Role Reward", value: `<@&${nextReward.role_id}> at Level **${nextReward.level}**` });
    }

    await interaction.editReply({ embeds: [embed] });
}

module.exports = {
    handleRank
};
