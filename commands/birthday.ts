import {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits,
    ChatInputCommandInteraction,
    TextChannel,
    GuildMember,
    Client
} from "discord.js";
import logger from "../utils/logger";

interface Birthday {
    userId: string;
    month: number;
    day: number;
    daysUntil?: number;
}

interface BirthdayManager {
    setBirthday(userId: string, guildId: string, month: number, day: number): Promise<void>;
    getBirthday(userId: string, guildId: string): Promise<Birthday | null>;
    removeBirthday(userId: string, guildId: string): Promise<boolean>;
    getUpcomingBirthdays(guildId: string, days: number): Promise<Birthday[]>;
    configureBirthdays(guildId: string, channelId: string, enabled: boolean): Promise<void>;
    checkBirthdays(): Promise<void>;
}

interface ExtendedClient extends Client {
    birthdayManager?: BirthdayManager;
}

interface CommandData {
    data: SlashCommandBuilder;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("birthday")
        .setDescription("Birthday tracking and announcements")
        .addSubcommand(sub => sub.setName("set").setDescription("Set your birthday")
            .addIntegerOption(opt => opt.setName("month").setDescription("Month (1-12)").setRequired(true).setMinValue(1).setMaxValue(12))
            .addIntegerOption(opt => opt.setName("day").setDescription("Day (1-31)").setRequired(true).setMinValue(1).setMaxValue(31)))
        .addSubcommand(sub => sub.setName("view").setDescription("View your saved birthday"))
        .addSubcommand(sub => sub.setName("remove").setDescription("Remove your birthday"))
        .addSubcommand(sub => sub.setName("upcoming").setDescription("View upcoming birthdays in this server")
            .addIntegerOption(opt => opt.setName("days").setDescription("Days ahead to check (default: 7)").setMinValue(1).setMaxValue(30)))
        .addSubcommand(sub => sub.setName("config").setDescription("Configure birthday announcements (Admin only)")
            .addChannelOption(opt => opt.setName("channel").setDescription("Channel for birthday announcements").setRequired(true))
            .addBooleanOption(opt => opt.setName("enabled").setDescription("Enable birthday announcements")))
        .addSubcommand(sub => sub.setName("check").setDescription("Manually check for birthdays today (Admin only)")),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        const client = interaction.client as ExtendedClient;
        const birthdayManager = client.birthdayManager;

        if (!birthdayManager) {
            await interaction.reply({ content: "❌ Birthday system is not available.", ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === "set") {
                const month = interaction.options.getInteger("month", true);
                const day = interaction.options.getInteger("day", true);

                await birthdayManager.setBirthday(interaction.user.id, interaction.guild!.id, month, day);

                await interaction.reply({
                    content: `🎉 Your birthday has been set to ${month}/${day}!`,
                    ephemeral: true
                });
            }

            else if (subcommand === "view") {
                const birthday = await birthdayManager.getBirthday(interaction.user.id, interaction.guild!.id);

                if (!birthday) {
                    await interaction.reply({
                        content: "🎂 You haven't set a birthday yet. Use `/birthday set` to set one!",
                        ephemeral: true
                    });
                    return;
                }

                await interaction.reply({
                    content: `🎈 Your birthday is set to ${birthday.month}/${birthday.day}`,
                    ephemeral: true
                });
            }

            else if (subcommand === "remove") {
                const removed = await birthdayManager.removeBirthday(interaction.user.id, interaction.guild!.id);

                if (removed) {
                    await interaction.reply({
                        content: "✅ Your birthday has been removed.",
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        content: "❌ You don't have a birthday set.",
                        ephemeral: true
                    });
                }
            }

            else if (subcommand === "upcoming") {
                await interaction.deferReply();

                const days = interaction.options.getInteger("days") || 7;
                const upcomingBirthdays = await birthdayManager.getUpcomingBirthdays(interaction.guild!.id, days);

                if (upcomingBirthdays.length === 0) {
                    await interaction.editReply({
                        content: `📅 No birthdays in the next ${days} days.`
                    });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor("#FF69B4")
                    .setTitle(`🎂 Upcoming Birthdays (Next ${days} Days)`)
                    .setFooter({ text: `${interaction.guild!.name}` })
                    .setTimestamp();

                for (const birthday of upcomingBirthdays) {
                    const member = await interaction.guild!.members.fetch(birthday.userId).catch(() => null);
                    const userName = member ? member.displayName : `<@${birthday.userId}>`;
                    const daysText = birthday.daysUntil === 0 ? "Today! 🎉" : `In ${birthday.daysUntil} day${birthday.daysUntil! > 1 ? 's' : ''}`;

                    embed.addFields({
                        name: userName,
                        value: `${birthday.month}/${birthday.day} - ${daysText}`,
                        inline: true
                    });
                }

                await interaction.editReply({ embeds: [embed] });
            }

            else if (subcommand === "config") {
                const member = interaction.member as GuildMember;
                if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await interaction.reply({
                        content: "❌ You need Administrator permission to configure birthdays.",
                        ephemeral: true
                    });
                    return;
                }

                const channel = interaction.options.getChannel("channel", true) as TextChannel;
                const enabled = interaction.options.getBoolean("enabled") ?? true;

                await birthdayManager.configureBirthdays(interaction.guild!.id, channel.id, enabled);

                await interaction.reply({
                    content: `✅ Birthday announcements ${enabled ? 'enabled' : 'disabled'} in ${channel}`,
                    ephemeral: true
                });
            }

            else if (subcommand === "check") {
                const member = interaction.member as GuildMember;
                if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await interaction.reply({
                        content: "❌ You need Administrator permission to manually check birthdays.",
                        ephemeral: true
                    });
                    return;
                }

                await interaction.deferReply({ ephemeral: true });

                await birthdayManager.checkBirthdays();

                await interaction.editReply({
                    content: "✅ Birthday check completed!"
                });
            }

        } catch (error: any) {
            logger.error(`[Birthday Command] Error: ${error.message}`);
            const replyMethod = interaction.deferred ? 'editReply' : 'reply';
            await interaction[replyMethod]({ content: `❌ An error occurred: ${error.message}`, ephemeral: true });
        }
    }
} as CommandData;