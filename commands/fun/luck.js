/*
 * /luck — daily random reward. CC-BY-NC-SA-4.0 derivative.
 */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { isEnabled as owoEnabled, assertSubcommandAllowed, OwoGateError } from '../../core/owo/manager.js';
import { rollDailyLuck, getLuckStats } from '../../core/owo/luck-service.js';
import { getCurrencyMeta } from '../../core/owo/cowoncy.js';

const data = new SlashCommandBuilder()
    .setName('luck')
    .setDescription('Roll today\'s lucky reward. Once per day, per server.')
    .setDMPermission(false);

async function execute(interaction) {
    if (!(await owoEnabled(interaction.guildId))) {
        return interaction.reply({ content: '🧺 OwO isn\'t enabled here.', ephemeral: true });
    }
    try { await assertSubcommandAllowed(interaction.guildId, 'luck'); }
    catch (e) {
        if (e instanceof OwoGateError) return interaction.reply({ content: e.message, ephemeral: true });
        throw e;
    }
    await interaction.deferReply();
    const r = await rollDailyLuck(interaction.guildId, interaction.user.id);
    if (r.cooldown) {
        const ts = Math.floor(r.availableAt / 1000);
        return interaction.editReply(`🎰 You\'ve already rolled today. Next roll <t:${ts}:R>.`);
    }
    const stats = await getLuckStats(interaction.guildId, interaction.user.id);
    const econ = await getCurrencyMeta(interaction.guildId);
    const color = r.prize.kind === 'jackpot' ? 0xFF0000 : (r.prize.kind === 'crate' ? 0x9C27B0 : 0xF0A500);
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`🎰 ${interaction.user.username} rolled their daily luck!`)
        .setDescription(`You got: **${r.prize.label}**`)
        .setFooter({ text: `Lifetime lucky rolls: ${stats.lifetimeRolls}` });
    if (r.prize.kind === 'cowoncy' || r.prize.kind === 'jackpot') {
        embed.addFields({ name: 'Reward', value: `+${r.prize.amount.toLocaleString()} ${econ.currency_emoji || '💰'}` });
    }
    await interaction.editReply({ embeds: [embed] });
}

export { data, execute };
export default { data, execute };
