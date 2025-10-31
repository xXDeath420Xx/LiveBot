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


export function parseTime(timeStr: any): any {
    const match = timeStr.match(/^(\d+)(s|m|h|d)$/);
    if (!match) {
        return null;
    }
    const value = parseInt(match[1]);
    const unit = match[2];
    let seconds = 0;
    switch (unit) {
        case "s":
            seconds = value;
            break;
        case "m":
            seconds = value * 60;
            break;
        case "h":
            seconds = value * 60 * 60;
            break;
        case "d":
            seconds = value * 24 * 60 * 60;
            break;
    }
    return new Date(Date.now() + seconds * 1000);
}

export async function handleStart(interaction: any): Promise<any> {
    const duration = interaction.options.getString("duration");
    const winners = interaction.options.getInteger("winners");
    const prize = interaction.options.getString("prize");
    const guildId = interaction.guild.id;

    const endsAt = parseTime(duration);
    if (!endsAt) {
        return interaction.editReply({ content: 'Invalid duration format. Use formats like `30m`, `2h`, `1d`.' });
    }

    const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle("🎉 GIVEAWAY 🎉")
        .setDescription(`Prize: **${prize}**\nWinners: **${winners}**\nReact with 🎉 to enter!`)
        .addFields({ name: "Ends", value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>` })
        .setFooter({ text: `Hosted by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp();

    const giveawayMessage = await interaction.channel.send({ embeds: [embed] });
    await giveawayMessage.react("🎉");

    await db.execute(
        "INSERT INTO giveaways (guild_id, channel_id, message_id, prize, winner_count, ends_at, host_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [guildId, interaction.channel.id, giveawayMessage.id, prize, winners, endsAt, interaction.user.id]
    );

    await interaction.editReply({ content: "✅ Giveaway started!" });
}

export async function handleEnd(interaction: any): Promise<any> {
    const messageId = interaction.options.getString("message-id");
    const guildId = interaction.guild.id;

    const [[giveaway]] = await db.execute(
        "SELECT * FROM giveaways WHERE message_id = ? AND guild_id = ? AND is_active = 1",
        [messageId, guildId]
    );

    if (!giveaway) {
        return interaction.editReply({ content: "❌ No active giveaway found with that message ID." });
    }

    await endGiveaway(giveaway, false);
    await interaction.editReply({ content: "✅ Giveaway ended successfully!" });
}

export async function handleReroll(interaction: any): Promise<any> {
    const messageId = interaction.options.getString("message-id");
    const guildId = interaction.guild.id;

    const [[giveaway]] = await db.execute(
        "SELECT * FROM giveaways WHERE message_id = ? AND guild_id = ?",
        [messageId, guildId]
    );

    if (!giveaway) {
        return interaction.editReply({ content: "❌ No giveaway found with that message ID." });
    }

    await endGiveaway(giveaway, true);
    await interaction.editReply({ content: "✅ Giveaway rerolled!" });
}

export async function handleList(interaction: any): Promise<any> {
    const guildId = interaction.guild.id;

    const [giveaways] = await db.execute(
        "SELECT * FROM giveaways WHERE guild_id = ? AND is_active = 1 ORDER BY ends_at ASC",
        [guildId]
    );

    if (giveaways.length === 0) {
        return interaction.editReply({ content: "There are no active giveaways on this server." });
    }

    const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle("🎉 Active Giveaways")
        .setDescription(giveaways.map(g =>
            `**${g.prize}**\nEnds: <t:${Math.floor(new Date(g.ends_at).getTime() / 1000)}:R>\n[Jump to Message](https://discord.com/channels/${guildId}/${g.channel_id}/${g.message_id})`
        ).join("\n\n"));

    await interaction.editReply({ embeds: [embed] });
}

export async function handleCancel(interaction: any): Promise<any> {
    const messageId = interaction.options.getString("message-id");
    const guildId = interaction.guild.id;

    const [[giveaway]] = await db.execute(
        "SELECT * FROM giveaways WHERE message_id = ? AND guild_id = ? AND is_active = 1",
        [messageId, guildId]
    );

    if (!giveaway) {
        return interaction.editReply({ content: "❌ No active giveaway found with that message ID." });
    }

    await db.execute("UPDATE giveaways SET is_active = 0 WHERE id = ?", [giveaway.id]);

    const channel = await interaction.guild.channels.fetch(giveaway.channel_id).catch(() => null);
    if (channel) {
        const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
        if (message) {
            const cancelledEmbed = EmbedBuilder.from(message.embeds[0])
                .setColor("#E74C3C")
                .setDescription(`**Giveaway Cancelled**\nThis giveaway has been cancelled by a moderator.`);
            await message.edit({ embeds: [cancelledEmbed], components: [] });
        }
    }

    await interaction.editReply({ content: "✅ Giveaway cancelled." });
}

module.exports = {
    handleStart,
    handleEnd,
    handleReroll,
    handleList,
    handleCancel
};
