import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ChatInputCommandInteraction,
    CacheType,
    GuildMember,
    Role
} from 'discord.js';

interface JoinableRanksManager {
    joinRank(member: GuildMember, roleId: string): Promise<{ success: boolean; error?: string; roleName?: string }>;
    leaveRank(member: GuildMember, roleId: string): Promise<{ success: boolean; error?: string; roleName?: string }>;
    createRanksEmbed(guild: any): Promise<EmbedBuilder>;
    addRank(guildId: string, roleId: string, description: string | null, category: string): Promise<{ success: boolean; error?: string }>;
    removeRank(guildId: string, roleId: string): Promise<{ success: boolean; error?: string }>;
    updateRankDescription(guildId: string, roleId: string, description: string): Promise<{ success: boolean }>;
    updateRankCategory(guildId: string, roleId: string, category: string): Promise<{ success: boolean }>;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rank')
        .setDescription('Self-assignable role commands')
        .addSubcommand(subcommand =>
            subcommand
                .setName('join')
                .setDescription('Join a self-assignable rank')
                .addRoleOption(option =>
                    option
                        .setName('role')
                        .setDescription('The rank to join')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('leave')
                .setDescription('Leave a self-assignable rank')
                .addRoleOption(option =>
                    option
                        .setName('role')
                        .setDescription('The rank to leave')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('View all available self-assignable ranks')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Add a role as a self-assignable rank (Admin only)')
                .addRoleOption(option =>
                    option
                        .setName('role')
                        .setDescription('The role to make joinable')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('description')
                        .setDescription('A description for this rank')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName('category')
                        .setDescription('Category for this rank (e.g. Games, Colors)')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove a self-assignable rank (Admin only)')
                .addRoleOption(option =>
                    option
                        .setName('role')
                        .setDescription('The rank to remove')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('edit')
                .setDescription('Edit a rank\'s description or category (Admin only)')
                .addRoleOption(option =>
                    option
                        .setName('role')
                        .setDescription('The rank to edit')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('description')
                        .setDescription('New description for this rank')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName('category')
                        .setDescription('New category for this rank')
                        .setRequired(false)
                )
        ),

    async execute(interaction: ChatInputCommandInteraction<CacheType>): Promise<void> {
        const subcommand = interaction.options.getSubcommand();
        const joinableRanks = (interaction.client as any).joinableRanks as JoinableRanksManager | undefined;

        if (!joinableRanks) {
            await interaction.reply({
                content: '❌ The joinable ranks system is not available.',
                ephemeral: true
            });
            return;
        }

        try {
            if (subcommand === 'join') {
                await interaction.deferReply({ ephemeral: true });
                const role = interaction.options.getRole('role') as Role;
                const member = interaction.member as GuildMember;
                const result = await joinableRanks.joinRank(member, role.id);

                if (result.success) {
                    await interaction.editReply({
                        content: `✅ You have been given the **${result.roleName}** rank!`
                    });
                } else {
                    await interaction.editReply({
                        content: `❌ ${result.error}`
                    });
                }

            } else if (subcommand === 'leave') {
                await interaction.deferReply({ ephemeral: true });
                const role = interaction.options.getRole('role') as Role;
                const member = interaction.member as GuildMember;
                const result = await joinableRanks.leaveRank(member, role.id);

                if (result.success) {
                    await interaction.editReply({
                        content: `✅ The **${result.roleName}** rank has been removed!`
                    });
                } else {
                    await interaction.editReply({
                        content: `❌ ${result.error}`
                    });
                }

            } else if (subcommand === 'list') {
                await interaction.deferReply();
                const embed = await joinableRanks.createRanksEmbed(interaction.guild);
                await interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'add') {
                const member = interaction.member as GuildMember;
                if (!member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                    await interaction.reply({
                        content: '❌ You need the **Manage Roles** permission to add joinable ranks.',
                        ephemeral: true
                    });
                    return;
                }

                await interaction.deferReply({ ephemeral: true });
                const role = interaction.options.getRole('role') as Role;
                const description = interaction.options.getString('description') || null;
                const category = interaction.options.getString('category') || 'General';

                const result = await joinableRanks.addRank(
                    interaction.guild!.id,
                    role.id,
                    description,
                    category
                );

                if (result.success) {
                    await interaction.editReply({
                        content: `✅ **${role.name}** has been added as a joinable rank!`
                    });
                } else {
                    await interaction.editReply({
                        content: `❌ ${result.error}`
                    });
                }

            } else if (subcommand === 'remove') {
                const member = interaction.member as GuildMember;
                if (!member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                    await interaction.reply({
                        content: '❌ You need the **Manage Roles** permission to remove joinable ranks.',
                        ephemeral: true
                    });
                    return;
                }

                await interaction.deferReply({ ephemeral: true });
                const role = interaction.options.getRole('role') as Role;

                const result = await joinableRanks.removeRank(interaction.guild!.id, role.id);

                if (result.success) {
                    await interaction.editReply({
                        content: `✅ **${role.name}** is no longer a joinable rank.`
                    });
                } else {
                    await interaction.editReply({
                        content: `❌ ${result.error}`
                    });
                }

            } else if (subcommand === 'edit') {
                const member = interaction.member as GuildMember;
                if (!member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                    await interaction.reply({
                        content: '❌ You need the **Manage Roles** permission to edit joinable ranks.',
                        ephemeral: true
                    });
                    return;
                }

                await interaction.deferReply({ ephemeral: true });
                const role = interaction.options.getRole('role') as Role;
                const description = interaction.options.getString('description');
                const category = interaction.options.getString('category');

                if (!description && !category) {
                    await interaction.editReply({
                        content: '❌ You must provide at least a description or category to update.'
                    });
                    return;
                }

                let updated = false;

                if (description) {
                    const result = await joinableRanks.updateRankDescription(
                        interaction.guild!.id,
                        role.id,
                        description
                    );
                    if (result.success) updated = true;
                }

                if (category) {
                    const result = await joinableRanks.updateRankCategory(
                        interaction.guild!.id,
                        role.id,
                        category
                    );
                    if (result.success) updated = true;
                }

                if (updated) {
                    await interaction.editReply({
                        content: `✅ **${role.name}** rank has been updated!`
                    });
                } else {
                    await interaction.editReply({
                        content: '❌ Failed to update the rank. Make sure it\'s a joinable rank.'
                    });
                }
            }

        } catch (error) {
            console.error('[Rank Command Error]', error as any);
            const replyMethod = interaction.deferred ? 'editReply' : 'reply';
            await interaction[replyMethod]({
                content: '❌ An error occurred while processing this command.',
                ephemeral: true
            });
        }
    },

    category: 'utility'
};