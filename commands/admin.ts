import {
    SlashCommandBuilder,
    PermissionsBitField,
    ChannelType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChatInputCommandInteraction,
    TextChannel,
    VoiceChannel,
    CategoryChannel,
    Role
} from "discord.js";
import db from "../utils/db";
import logger from "../utils/logger";

interface CommandData {
    data: SlashCommandBuilder;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
    category: string;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("admin")
        .setDescription("Administrative commands for server management.")
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addSubcommand(subcommand =>
            subcommand
                .setName("setup-requests")
                .setDescription("Creates the panel for users to request live announcements.")
                .addChannelOption(option =>
                    option.setName("panel-channel")
                        .setDescription("The channel where the request panel will be posted.")
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true))
                .addChannelOption(option =>
                    option.setName("requests-channel")
                        .setDescription("The channel where the bot will post the requests for approval.")
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true))
        )
        .addSubcommandGroup(group =>
            group
                .setName('temp-channel')
                .setDescription('Manages the automatic temporary voice channel system.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("setup")
                        .setDescription("Sets up the temp channel creator.")
                        .addChannelOption(option =>
                            option.setName("creator-channel")
                                .setDescription("The voice channel users join to create a new channel.")
                                .addChannelTypes(ChannelType.GuildVoice)
                                .setRequired(true)
                        )
                        .addChannelOption(option =>
                            option.setName("category")
                                .setDescription("The category where new temp channels will be created.")
                                .addChannelTypes(ChannelType.GuildCategory)
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option.setName("naming-template")
                                .setDescription("The name for new channels. Use {user} for the user's name.")
                        )
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("disable")
                        .setDescription("Disables the temp channel system.")
                )
        )
        .addSubcommandGroup(group =>
            group
                .setName('verification')
                .setDescription('Manages the server verification gate.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("setup")
                        .setDescription("Creates the verification panel in a channel.")
                        .addChannelOption(option =>
                            option.setName("channel")
                                .setDescription("The channel where users will verify.")
                                .addChannelTypes(ChannelType.GuildText)
                                .setRequired(true)
                        )
                        .addRoleOption(option =>
                            option.setName("role")
                                .setDescription("The role to grant to users upon verification.")
                                .setRequired(true)
                        )
                )
        ),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        const subcommandGroup = interaction.options.getSubcommandGroup(false);
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'setup-requests') {
            const panelChannel = interaction.options.getChannel("panel-channel") as TextChannel | null;
            const requestsChannel = interaction.options.getChannel("requests-channel") as TextChannel | null;

            if (!panelChannel || !requestsChannel) {
                await interaction.reply({
                    content: "❌ Could not resolve one or both of the channels. Please make sure I have permissions to view both channels and try again.",
                    ephemeral: true
                });
                return;
            }

            const embed = new EmbedBuilder()
                .setColor("#5865F2")
                .setTitle("Request Live Stream Announcements")
                .setDescription("Click the button below to open a form and add your stream to the announcement list for this server.")
                .setFooter({ text: "CertiFried MultiTool | User Requests" });

            const requestButton = new ButtonBuilder()
                .setCustomId(`request_announcement_button_${requestsChannel.id}`)
                .setLabel("Request Announcements")
                .setStyle(ButtonStyle.Success)
                .setEmoji("📡");

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(requestButton);

            try {
                await panelChannel.send({ embeds: [embed], components: [row] });
                await interaction.reply({
                    content: `✅ Successfully posted the request panel in ${panelChannel} and requests will be sent to ${requestsChannel}.`,
                    ephemeral: true
                });
            } catch (error) {
                logger.error("Failed to post request panel:", error as Record<string, any>);
                await interaction.reply({
                    content: `❌ Could not post the panel in ${panelChannel}. Please ensure I have permissions to send messages and embeds there.`,
                    ephemeral: true
                });
            }

        } else if (subcommandGroup === 'temp-channel') {
            await interaction.deferReply({ ephemeral: true });
            try {
                if (subcommand === "setup") {
                    const creatorChannel = interaction.options.getChannel("creator-channel") as VoiceChannel;
                    const category = interaction.options.getChannel("category") as CategoryChannel;
                    const template = interaction.options.getString("naming-template") || "{user}'s Channel";

                    await db.execute(
                        "INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE creator_channel_id = VALUES(creator_channel_id), category_id = VALUES(category_id), naming_template = VALUES(naming_template)",
                        [interaction.guild!.id, creatorChannel.id, category.id, template]
                    );

                    await interaction.editReply(`✅ System enabled! Users joining ${creatorChannel} will now create a temporary channel in the **${category.name}** category.`);
                } else if (subcommand === "disable") {
                    await db.execute("DELETE FROM temp_channel_config WHERE guild_id = ?", [interaction.guild!.id]);
                    await interaction.editReply("🗑️ The temporary channel system has been disabled.");
                }
            } catch (error) {
                logger.error("[Temp Channel Command Error]", error as Record<string, any>);
                await interaction.editReply({ content: "An _error occurred while managing the temporary channel system." });
            }

        } else if (subcommandGroup === 'verification') {
            if (subcommand === "setup") {
                await interaction.deferReply({ ephemeral: true });
                const channel = interaction.options.getChannel("channel") as TextChannel;
                const role = interaction.options.getRole("role") as Role;

                if (!role.editable) {
                    await interaction.editReply("I cannot assign this role. Please make sure my role is higher than the verification role.");
                    return;
                }

                try {
                    await db.execute(
                        `INSERT INTO join_gate_config (guild_id, verification_enabled, verification_role_id, verification_channel_id)
                         VALUES (?, 1, ?, ?)
                         ON DUPLICATE KEY UPDATE
                            verification_enabled = 1,
                            verification_role_id = VALUES(verification_role_id),
                            verification_channel_id = VALUES(verification_channel_id)`,
                        [interaction.guild!.id, role.id, channel.id]
                    );

                    const embed = new EmbedBuilder()
                        .setColor("#2ECC71")
                        .setTitle(`Welcome to ${interaction.guild!.name}!`)
                        .setDescription("To gain access to the rest of the server, please click the button below to verify that you are human.")
                        .setFooter({ text: "This helps protect our community from raids and bots." });

                    const row = new ActionRowBuilder<ButtonBuilder>()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId("verify_member")
                                .setLabel("Verify")
                                .setStyle(ButtonStyle.Success)
                                .setEmoji("✅")
                        );

                    await channel.send({ embeds: [embed], components: [row] });
                    await interaction.editReply(`✅ Verification panel has been created in ${channel}.`);

                } catch (error) {
                    logger.error("[Verification Setup Error]", error as Record<string, any>);
                    await interaction.editReply("An _error occurred. I may be missing permissions to send messages in that channel.");
                }
            }
        }
    },
    category: "Admin",
} as CommandData;