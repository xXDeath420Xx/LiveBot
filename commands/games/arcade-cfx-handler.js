import { EmbedBuilder } from 'discord.js';
import * as cfxCommands from '../../services/certifried-extension/bot/commands.js';
import { formatCurrency } from '../../services/certifried-extension/bot/formatters.js';

function buildUser(interaction) {
    return {
        id: interaction.user.id,
        username: interaction.user.username,
        displayName: interaction.user.displayName || interaction.user.username,
        avatar: interaction.user.displayAvatarURL({ dynamic: true })
    };
}

export async function handleStats(interaction) {
    await interaction.deferReply();
    const user = buildUser(interaction);

    const message = await cfxCommands.handleStatsCommand(user, 'discord');

    const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('🌿 CertiFried Garden')
        .setDescription(message)
        .setThumbnail(user.avatar)
        .setFooter({ text: 'Use /arcade cfx play to open the game!' });

    await interaction.editReply({ embeds: [embed] });
}

export async function handleDaily(interaction) {
    await interaction.deferReply();
    const user = buildUser(interaction);

    const result = await cfxCommands.handleDailyReward(user, 'discord');

    const embed = new EmbedBuilder()
        .setColor(result.success ? 0x22c55e : 0xef4444)
        .setTitle(result.success ? '🌿 Daily Harvest' : '⏰ Already Claimed')
        .setDescription(result.message);

    if (result.success) {
        embed.addFields({
            name: '💰 Reward',
            value: formatCurrency(result.amount),
            inline: true
        });
    }

    await interaction.editReply({ embeds: [embed] });
}

export async function handleLeaderboard(interaction) {
    await interaction.deferReply();

    const type = interaction.options.getString('type') || 'level';
    const message = await cfxCommands.handleLeaderboardCommand(type, 10);

    const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('🏆 CertiFried Leaderboard')
        .setDescription(message)
        .setFooter({ text: `Sorted by ${type}` });

    await interaction.editReply({ embeds: [embed] });
}

export async function handleMarket(interaction) {
    await interaction.deferReply();

    const message = await cfxCommands.handleMarketCommand();

    const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('📈 CertiFried Market')
        .setDescription(message)
        .setFooter({ text: 'Prices update every hour' });

    await interaction.editReply({ embeds: [embed] });
}

export async function handleSell(interaction) {
    await interaction.deferReply();
    const user = buildUser(interaction);

    const strainName = interaction.options.getString('strain');
    const quantity = interaction.options.getInteger('quantity') || 1;

    const message = await cfxCommands.handleQuickSellCommand(user, 'discord', strainName, quantity);

    const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('💰 Quick Sell')
        .setDescription(message);

    await interaction.editReply({ embeds: [embed] });
}

export async function handlePlay(interaction) {
    const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('🌿 CertiFried - Cannabis Tycoon')
        .setDescription('Grow, breed, and trade cannabis strains in this idle tycoon game!')
        .addFields(
            { name: '🎮 Twitch Extension', value: 'Find it on streams with the CertiFried panel installed', inline: true },
            { name: '🌐 Web App', value: '[Play Now](https://certifriedmultitool.com/cfx)', inline: true }
        )
        .setFooter({ text: 'Your Discord account links automatically when you play!' });

    await interaction.reply({ embeds: [embed] });
}
