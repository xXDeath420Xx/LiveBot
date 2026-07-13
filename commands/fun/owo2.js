/*
 * /owo2 — overflow slash command for features that didn't fit in /owo's
 * 25-subcommand cap. Houses weapon progression (shards / dismantle / forge /
 * favorite), ranch claim, and future feature additions.
 *
 * CC-BY-NC-SA-4.0 derivative. See /LICENSE-OWO-NOTICE.md.
 */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import {
    isEnabled as owoEnabled, assertSubcommandAllowed,
    assertChannelAllowed, assertRolesAllowed, OwoGateError,
} from '../../core/owo/manager.js';
import {
    getShards, dismantleWeapon, forgeWeapon, setFavorite,
    FORGE_COSTS,
} from '../../core/owo/weapons-service.js';
import { getCurrencyMeta } from '../../core/owo/cowoncy.js';
import * as ranch from '../../core/owo/ranch-service.js';
import { progressQuest } from '../../core/owo/quests-service.js';

const RANK_COLOR = {
    Common: 0x9E9E9E, Uncommon: 0x4CAF50, Rare: 0x2196F3, Epic: 0x9C27B0,
    Mythical: 0xFF9800, Legendary: 0xF44336, Fabled: 0xE91E63,
};

const data = new SlashCommandBuilder()
    .setName('owo2')
    .setDescription('Extra OwO commands that overflowed the main /owo limit.')
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('shards')
        .setDescription('See how many weapon shards you have.'))
    .addSubcommand(sub => sub.setName('dismantle')
        .setDescription('Break down a weapon into shards based on its rank.')
        .addIntegerOption(opt => opt.setName('uwid').setDescription('Weapon id to dismantle').setRequired(true)))
    .addSubcommand(sub => sub.setName('forge')
        .setDescription('Spend shards to forge a new weapon at a specific rank.')
        .addStringOption(opt => opt.setName('rank').setDescription('Target rank').setRequired(true)
            .addChoices(
                { name: 'Common (5 shards)',      value: 'Common' },
                { name: 'Uncommon (15 shards)',   value: 'Uncommon' },
                { name: 'Rare (40 shards)',       value: 'Rare' },
                { name: 'Epic (200 shards)',      value: 'Epic' },
                { name: 'Mythical (2,000)',       value: 'Mythical' },
                { name: 'Legendary (7,500)',      value: 'Legendary' },
                { name: 'Fabled (30,000)',        value: 'Fabled' },
            )))
    .addSubcommand(sub => sub.setName('favorite')
        .setDescription('Mark a weapon as favorite — protected from dismantle.')
        .addIntegerOption(opt => opt.setName('uwid').setDescription('Weapon id').setRequired(true))
        .addBooleanOption(opt => opt.setName('favorite').setDescription('True = favorite, False = remove favorite').setRequired(true)))
    .addSubcommand(sub => sub.setName('forge-prices')
        .setDescription('Show the shard costs to forge each weapon rank.'))
    .addSubcommand(sub => sub.setName('ranch')
        .setDescription('View your ranch: passive currency from pets on your active team.'))
    .addSubcommand(sub => sub.setName('ranch-claim')
        .setDescription('Collect accrued currency from your ranch (max 24h of accrual).'));

async function gate(interaction, subname) {
    if (!(await owoEnabled(interaction.guildId))) {
        await interaction.reply({ content: '🧺 OwO isn\'t enabled here.', ephemeral: true });
        return false;
    }
    try { await assertSubcommandAllowed(interaction.guildId, subname); }
    catch (e) {
        if (e instanceof OwoGateError) {
            await interaction.reply({ content: e.message, ephemeral: true });
            return false;
        }
        throw e;
    }
    return true;
}

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (!(await gate(interaction, sub))) return;

    // Count /owo2 invocations toward the "owo" quest — same rule as /owo.
    progressQuest(interaction.guildId, interaction.user.id, 'owo', 1).catch(() => {});

    if (sub === 'shards')        return handleShards(interaction);
    if (sub === 'dismantle')     return handleDismantle(interaction);
    if (sub === 'forge')         return handleForge(interaction);
    if (sub === 'favorite')      return handleFavorite(interaction);
    if (sub === 'forge-prices')  return handleForgePrices(interaction);
    if (sub === 'ranch')         return handleRanch(interaction);
    if (sub === 'ranch-claim')   return handleRanchClaim(interaction);
}

async function handleRanch(interaction) {
    await interaction.deferReply();
    const s = await ranch.status(interaction.guildId, interaction.user.id);
    if (!s.hasTeam) return interaction.editReply('🐑 No active team. Add animals with `/owo team-add`.');
    const econ = await getCurrencyMeta(interaction.guildId);
    const cmoji = econ.currency_emoji || '💰';
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setTitle(`🐑 ${interaction.user.username}'s Ranch`)
        .setDescription(
            `**${s.teamSize}** pet${s.teamSize === 1 ? '' : 's'} earning **${s.hourlyRate.toLocaleString()}** ${cmoji} per hour.\n` +
            `Accrued: **${s.hoursAccrued}** / ${s.maxHours} hours → **${s.pendingPayout.toLocaleString()}** ${cmoji} pending.`
        )
        .setFooter({ text: `Next hour ticks in ~${s.nextTickMinutes} min · Claim with /owo2 ranch-claim` });
    await interaction.editReply({ embeds: [embed] });
}

async function handleRanchClaim(interaction) {
    await interaction.deferReply();
    const r = await ranch.claim(interaction.guildId, interaction.user.id);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    const econ = await getCurrencyMeta(interaction.guildId);
    const cmoji = econ.currency_emoji || '💰';
    if (r.claimed === 0) {
        return interaction.editReply(r.note
            ? `ℹ️ ${r.note}`
            : `⏳ Nothing to claim yet — next tick in ~${r.nextInMinutes} min.`);
    }
    await interaction.editReply(
        `🐑 Claimed **${r.hours}h** × ${r.hourly.toLocaleString()} ${cmoji}/h = **+${r.claimed.toLocaleString()}** ${cmoji}.`
    );
}

async function handleShards(interaction) {
    await interaction.deferReply();
    const n = await getShards(interaction.guildId, interaction.user.id);
    await interaction.editReply(`💠 You have **${n.toLocaleString()}** weapon shards.`);
}

async function handleDismantle(interaction) {
    await interaction.deferReply();
    const uwid = interaction.options.getInteger('uwid');
    const r = await dismantleWeapon(interaction.guildId, interaction.user.id, uwid);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    const total = await getShards(interaction.guildId, interaction.user.id);
    await interaction.editReply(
        `🔨 Dismantled **${r.rank}** weapon #${r.uwid} → **+${r.shards}** 💠 shards. ` +
        `You now have **${total.toLocaleString()}** shards.`
    );
}

async function handleForge(interaction) {
    await interaction.deferReply();
    const rank = interaction.options.getString('rank');
    const r = await forgeWeapon(interaction.guildId, interaction.user.id, rank);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    const embed = new EmbedBuilder()
        .setColor(RANK_COLOR[r.weapon.rank] || 0xF0A500)
        .setTitle(`🔨 Forged ${r.weapon.emoji} ${r.weapon.rank} ${r.weapon.name}`)
        .setDescription(r.weapon.basicDesc || '*A new weapon, made from raw shards.*')
        .addFields(
            { name: 'Stat', value: String(r.weapon.stat), inline: true },
            { name: 'Shards spent', value: String(r.shardsSpent), inline: true },
            { name: 'Shards left', value: String(r.shardsLeft), inline: true }
        );
    if (r.weapon.passives?.length) {
        embed.addFields({ name: 'Passives', value: r.weapon.passives.map(p => `• **${p.name}** (+${p.quality})`).join('\n') });
    }
    embed.setFooter({ text: `uwid: ${r.weapon.uwid}` });
    await interaction.editReply({ embeds: [embed] });
}

async function handleFavorite(interaction) {
    await interaction.deferReply();
    const uwid = interaction.options.getInteger('uwid');
    const favorite = interaction.options.getBoolean('favorite');
    const r = await setFavorite(interaction.guildId, interaction.user.id, uwid, favorite);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    await interaction.editReply(r.favorite
        ? `⭐ Weapon #${r.uwid} is now favorited (safe from dismantle).`
        : `✖️ Weapon #${r.uwid} is no longer a favorite.`);
}

async function handleForgePrices(interaction) {
    await interaction.deferReply();
    const lines = Object.entries(FORGE_COSTS).map(([rank, cost]) => `**${rank}**: ${cost.toLocaleString()} 💠`);
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setTitle('🔨 Forge Prices')
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Dismantle weapons for shards · /owo2 dismantle uwid:<#>' });
    await interaction.editReply({ embeds: [embed] });
}

export { data, execute };
export default { data, execute };
