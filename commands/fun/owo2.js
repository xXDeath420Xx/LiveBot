/*
 * /owo2 — overflow slash command for features that didn't fit in /owo's
 * 25-subcommand cap. Houses weapon progression (shards / dismantle / forge /
 * favorite), ranch claim, and the social/economy ports from upstream OwO:
 * pray / curse, cookies, social rankings, lottery, cowoncy drops, friendly
 * battles with bets, battle settings, give limits + transfer log, wallpapers,
 * rings and marriage. The chat prefix (`owo pray`, `owo marry` …) reaches the
 * same code through handlers/owo-social.js.
 *
 * Top level: 18 subcommands + 3 groups = 21 of Discord's 25.
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
import { displayNameFor } from '../../utils/display-name.js';
import { progressQuest } from '../../core/owo/quests-service.js';
import { themeColor } from '../../core/guild-theme.js';
import { runBattle } from '../../core/owo/battle-pvp.js';
import { MAX_BATTLE_BET, LOTTERY_MAX_BET, WALLPAPER_SHOP_OFFSET } from '../../core/owo/social-math.js';
import * as owoSocial from '../../handlers/owo-social.js';

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
        .setDescription('Collect accrued currency from your ranch (max 24h of accrual).'))
    // ── Social ──
    .addSubcommand(sub => sub.setName('pray')
        .setDescription('Pray for yourself or someone else (luck points). 5 min cooldown.')
        .addUserOption(o => o.setName('user').setDescription('Who to pray for (gives them your luck)').setRequired(false)))
    .addSubcommand(sub => sub.setName('curse')
        .setDescription('Curse yourself or someone else (takes their luck). 5 min cooldown.')
        .addUserOption(o => o.setName('user').setDescription('Who to curse').setRequired(false)))
    .addSubcommand(sub => sub.setName('cookie')
        .setDescription('Give someone your daily cookie, or see how many you have.')
        .addUserOption(o => o.setName('user').setDescription('Who gets the cookie (leave empty to see yours)').setRequired(false)))
    .addSubcommand(sub => sub.setName('top')
        .setDescription('Server rankings for cookies, luck, or curses.')
        .addStringOption(o => o.setName('type').setDescription('Which ranking').setRequired(true)
            .addChoices(
                { name: 'Cookies', value: 'cookies' },
                { name: 'Luck', value: 'luck' },
                { name: 'Curses', value: 'curse' },
            )))
    // ── Economy ──
    .addSubcommand(sub => sub.setName('lottery')
        .setDescription('Enter the nightly lottery (each cowoncy is a ticket) or see the pot.')
        .addIntegerOption(o => o.setName('amount').setDescription('Cowoncy to put in (leave empty to see the status)')
            .setRequired(false).setMinValue(1).setMaxValue(LOTTERY_MAX_BET))
        .addBooleanOption(o => o.setName('all').setDescription('Put in as much as you can (up to the round limit)').setRequired(false)))
    .addSubcommand(sub => sub.setName('drop')
        .setDescription("Drop cowoncy on this channel's floor for someone to pick up.")
        .addIntegerOption(o => o.setName('amount').setDescription('How much to drop').setRequired(true).setMinValue(1)))
    .addSubcommand(sub => sub.setName('pickup')
        .setDescription("Pick cowoncy up from this channel's floor — guess how much is there!")
        .addIntegerOption(o => o.setName('amount').setDescription('How much to pick up').setRequired(true).setMinValue(1)))
    .addSubcommand(sub => sub.setName('give-limits')
        .setDescription('How much cowoncy you can still send and receive today.'))
    .addSubcommand(sub => sub.setName('transactions')
        .setDescription('Recent cowoncy transfers (others / whole server need Manage Server).')
        .addUserOption(o => o.setName('user').setDescription('Whose transfers').setRequired(false))
        .addBooleanOption(o => o.setName('server').setDescription('Every transfer in this server').setRequired(false)))
    // ── Battles ──
    .addSubcommand(sub => sub.setName('duel')
        .setDescription('Challenge a member to a friendly battle, optionally betting cowoncy.')
        .addUserOption(o => o.setName('opponent').setDescription('Who to challenge').setRequired(true))
        .addIntegerOption(o => o.setName('bet').setDescription('Cowoncy each side stakes; the winner takes both')
            .setRequired(false).setMinValue(1).setMaxValue(MAX_BATTLE_BET)))
    .addSubcommand(sub => sub.setName('battle-settings')
        .setDescription('How your battles are shown.')
        .addStringOption(o => o.setName('display').setDescription('Full turn log or a compact summary').setRequired(false)
            .addChoices({ name: 'Text (full log)', value: 'text' }, { name: 'Compact', value: 'compact' }))
        .addStringOption(o => o.setName('speed').setDescription('Replay the fight turn by turn').setRequired(false)
            .addChoices({ name: 'Instant', value: 'instant' }, { name: 'Short', value: 'short' }, { name: 'Lengthy', value: 'lengthy' }))
        .addBooleanOption(o => o.setName('logs').setDescription('Attach the full battle log as a file').setRequired(false)))
    // ── Groups ──
    .addSubcommandGroup(g => g.setName('wallpaper')
        .setDescription('Profile wallpapers.')
        .addSubcommand(sub => sub.setName('shop').setDescription('Wallpapers for sale (pick one to preview it).')
            .addIntegerOption(o => o.setName('id').setDescription('Shop id to preview (e.g. 201)').setRequired(false).setMinValue(1)))
        .addSubcommand(sub => sub.setName('buy').setDescription('Buy a wallpaper.')
            .addIntegerOption(o => o.setName('id').setDescription('Shop id (e.g. 201)').setRequired(true).setMinValue(1)))
        .addSubcommand(sub => sub.setName('equip').setDescription('Put an owned wallpaper on your profile.')
            .addIntegerOption(o => o.setName('id').setDescription('Shop id (e.g. 201)').setRequired(true).setMinValue(1)))
        .addSubcommand(sub => sub.setName('unequip').setDescription('Take your wallpaper off.'))
        .addSubcommand(sub => sub.setName('owned').setDescription('Wallpapers you own.')))
    .addSubcommandGroup(g => g.setName('ring')
        .setDescription('Marriage rings.')
        .addSubcommand(sub => sub.setName('shop').setDescription('Rings and wallpapers for sale.'))
        .addSubcommand(sub => sub.setName('buy').setDescription('Buy a ring.')
            .addIntegerOption(o => o.setName('id').setDescription('Ring id 1-7').setRequired(true).setMinValue(1).setMaxValue(7)))
        .addSubcommand(sub => sub.setName('sell').setDescription('Sell a ring back for 75% of its price.')
            .addIntegerOption(o => o.setName('id').setDescription('Ring id 1-7').setRequired(true).setMinValue(1).setMaxValue(7)))
        .addSubcommand(sub => sub.setName('inventory').setDescription('Rings you own.')))
    .addSubcommandGroup(g => g.setName('marry')
        .setDescription('Marriage — a daily bonus for both of you.')
        .addSubcommand(sub => sub.setName('propose').setDescription('Propose with a ring (or swap rings with your partner).')
            .addUserOption(o => o.setName('user').setDescription('Who to marry').setRequired(true))
            .addIntegerOption(o => o.setName('ring').setDescription('Ring id 1-7 (buy one first)').setRequired(true).setMinValue(1).setMaxValue(7)))
        .addSubcommand(sub => sub.setName('accept').setDescription('Accept the proposal sent to you.'))
        .addSubcommand(sub => sub.setName('decline').setDescription('Decline a proposal, or withdraw yours.'))
        .addSubcommand(sub => sub.setName('divorce').setDescription('End your marriage (the ring breaks).'))
        .addSubcommand(sub => sub.setName('status').setDescription('Your marriage, or pending proposals.')));

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
    const group = interaction.options.getSubcommandGroup(false);
    // Groups gate on their group name (`wallpaper`, `ring`, `marry`), subcommands on their own.
    if (!(await gate(interaction, group || sub))) return;

    // Count /owo2 invocations toward the "owo" quest — same rule as /owo.
    progressQuest(interaction.guildId, interaction.user.id, 'owo', 1).catch(() => {});

    if (sub === 'shards')        return handleShards(interaction);
    if (sub === 'dismantle')     return handleDismantle(interaction);
    if (sub === 'forge')         return handleForge(interaction);
    if (sub === 'favorite')      return handleFavorite(interaction);
    if (sub === 'forge-prices')  return handleForgePrices(interaction);
    if (sub === 'ranch')         return handleRanch(interaction);
    if (sub === 'ranch-claim')   return handleRanchClaim(interaction);

    const opt = interaction.options;
    if (group === 'wallpaper') {
        const id = opt.getInteger('id');
        if (sub === 'shop')     return id ? owoSocial.wallpaperPreviewCmd(interaction, id) : owoSocial.shopCmd(interaction);
        if (sub === 'buy')      return owoSocial.buyCmd(interaction, id > WALLPAPER_SHOP_OFFSET ? id : WALLPAPER_SHOP_OFFSET + id);
        if (sub === 'equip')    return owoSocial.wallpaperCmd(interaction, id);
        if (sub === 'unequip')  return owoSocial.wallpaperCmd(interaction, 'none');
        if (sub === 'owned')    return owoSocial.wallpaperCmd(interaction, null);
    }
    if (group === 'ring') {
        if (sub === 'shop')      return owoSocial.shopCmd(interaction);
        if (sub === 'buy')       return owoSocial.buyCmd(interaction, opt.getInteger('id'));
        if (sub === 'sell')      return owoSocial.sellRingCmd(interaction, opt.getInteger('id'));
        if (sub === 'inventory') return owoSocial.ringInventoryCmd(interaction);
    }
    if (group === 'marry') {
        if (sub === 'propose')  return owoSocial.marryCmd(interaction, opt.getUser('user'), opt.getInteger('ring'));
        if (sub === 'accept')   return owoSocial.acceptMarriageCmd(interaction);
        if (sub === 'decline')  return owoSocial.declineMarriageCmd(interaction);
        if (sub === 'divorce')  return owoSocial.divorceCmd(interaction);
        if (sub === 'status')   return owoSocial.marryCmd(interaction, null, null);
    }
    if (sub === 'pray' || sub === 'curse') return owoSocial.prayCmd(interaction, sub, opt.getUser('user'));
    if (sub === 'cookie')          return owoSocial.cookieCmd(interaction, opt.getUser('user'));
    if (sub === 'top')             return owoSocial.topSocialCmd(interaction, opt.getString('type'));
    if (sub === 'lottery')         return owoSocial.lotteryCmd(interaction, opt.getBoolean('all') ? 'all' : opt.getInteger('amount'));
    if (sub === 'drop')            return owoSocial.dropCmd(interaction, opt.getInteger('amount'));
    if (sub === 'pickup')          return owoSocial.pickupCmd(interaction, opt.getInteger('amount'));
    if (sub === 'give-limits')     return owoSocial.limitsCmd(interaction);
    if (sub === 'transactions')    return owoSocial.transactionsCmd(interaction, { target: opt.getUser('user'), all: !!opt.getBoolean('server') });
    if (sub === 'duel')            return runBattle(interaction, { opponent: opt.getUser('opponent'), bet: opt.getInteger('bet') ?? 0 });
    if (sub === 'battle-settings') {
        const logs = opt.getBoolean('logs');
        return owoSocial.battleSettingsCmd(interaction, {
            display: opt.getString('display'), speed: opt.getString('speed'), logs: logs == null ? undefined : logs,
        });
    }
}

async function handleRanch(interaction) {
    await interaction.deferReply();
    const s = await ranch.status(interaction.guildId, interaction.user.id);
    if (!s.hasTeam) return interaction.editReply('🐑 No active team. Add animals with `/owo team-add`.');
    const econ = await getCurrencyMeta(interaction.guildId);
    const cmoji = econ.currency_emoji || '💰';
    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'warning'))
        .setTitle(`🐑 ${displayNameFor(interaction.user, interaction.guild)}'s Ranch`)
        .setDescription(
            `**${s.teamSize}** pet${s.teamSize === 1 ? '' : 's'} earning **${s.hourlyRate.toLocaleString()}** ${cmoji} per hour.\n` +
            `Accrued: **${s.hoursAccrued}** / ${s.maxHours} hours → **${s.pendingPayout.toLocaleString()}** ${cmoji} pending.`
        )
        .setFooter({ text: `Next hour ticks in ~${s.nextTickMinutes} min · Claim with /owo ranch-claim` });
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
        .setColor(themeColor(interaction.guildId, 'warning'))
        .setTitle('🔨 Forge Prices')
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Dismantle weapons for shards · /owo dismantle uwid:<#>' });
    await interaction.editReply({ embeds: [embed] });
}

export { data, execute };
export default { data, execute };
