/*
 * /autohunt command — top-level because /owo is at its 25-subcommand cap.
 * CC-BY-NC-SA-4.0 derivative. See /LICENSE-OWO-NOTICE.md.
 */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { isEnabled as owoEnabled, OwoGateError, assertSubcommandAllowed } from '../../core/owo/manager.js';
import { enable, disable, claim, status } from '../../core/owo/autohunt-service.js';
import { getCurrencyMeta } from '../../core/owo/cowoncy.js';

const data = new SlashCommandBuilder()
    .setName('autohunt')
    .setDescription('Passive hunting — queues animals while you\'re away.')
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('enable').setDescription('Turn on passive hunting (1 hunt per 30 minutes, cap 24 queued).'))
    .addSubcommand(sub => sub.setName('disable').setDescription('Turn passive hunting off.'))
    .addSubcommand(sub => sub.setName('status').setDescription('See how many hunts are queued and when the next fires.'))
    .addSubcommand(sub => sub.setName('claim').setDescription('Collect all queued animals and currency.'));

async function gate(interaction) {
    if (!(await owoEnabled(interaction.guildId))) {
        await interaction.reply({ content: '🧺 OwO isn\'t enabled here. Ask an admin to run `/owo toggle enabled:True`.', ephemeral: true });
        return false;
    }
    try {
        await assertSubcommandAllowed(interaction.guildId, 'autohunt');
    } catch (e) {
        if (e instanceof OwoGateError) {
            await interaction.reply({ content: e.message, ephemeral: true });
            return false;
        }
        throw e;
    }
    return true;
}

async function execute(interaction) {
    if (!(await gate(interaction))) return;
    const sub = interaction.options.getSubcommand();
    const { guildId, user, client } = interaction;

    if (sub === 'enable') {
        await interaction.deferReply();
        const r = await enable(guildId, user.id);
        return interaction.editReply(`🌅 Autohunt **enabled**. Every **${Math.round(r.intervalMs/60000)} min** an animal is queued (up to 24). Come back and \`/autohunt claim\`.`);
    }
    if (sub === 'disable') {
        await interaction.deferReply();
        const r = await disable(guildId, user.id);
        return interaction.editReply(r.disabled ? '🌙 Autohunt **disabled**.' : 'ℹ️ Autohunt wasn\'t enabled.');
    }
    if (sub === 'status') {
        await interaction.deferReply();
        const s = await status(guildId, user.id);
        if (!s.enabled) return interaction.editReply('🌙 Autohunt is **disabled**. `/autohunt enable` to start.');
        return interaction.editReply(
            `🌅 Autohunt is **on**. Queued: **${s.queued}/${s.queuedCap}**. ` +
            `Next hunt in ~${s.nextInMinutes} min. Lifetime autohunted: **${s.totalLifetime.toLocaleString()}**.`
        );
    }
    if (sub === 'claim') {
        await interaction.deferReply();
        const r = await claim(guildId, user.id);
        if (r.error) return interaction.editReply(`❌ ${r.error}`);
        if (r.claimed === 0) return interaction.editReply(`⏳ Nothing queued yet — next hunt in ~${r.nextInMinutes} min.`);
        const econ = await getCurrencyMeta(guildId);
        const rankLines = Object.entries(r.byRank)
            .sort((a, b) => b[1] - a[1])
            .map(([rank, n]) => `**${rank}** × ${n}`)
            .join(' · ');
        const embed = new EmbedBuilder()
            .setColor(0xF0A500)
            .setTitle(`🌅 Autohunt — collected ${r.claimed} animals`)
            .setDescription(rankLines || '—')
            .addFields(
                { name: 'Currency', value: `+${r.totalPoints.toLocaleString()} ${econ.currency_emoji || '💰'}`, inline: true },
            );
        return interaction.editReply({ embeds: [embed] });
    }
}

export { data, execute };
export default { data, execute };
