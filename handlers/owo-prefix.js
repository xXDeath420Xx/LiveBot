/*
 * Prefix-command handlers for the OwO module.
 * CC-BY-NC-SA-4.0 derivative file. See /LICENSE-OWO-NOTICE.md.
 */
import { EmbedBuilder } from 'discord.js';
import {
    hunt, getZoo, getLeaderboard, isEnabled,
    sellRank, sacrificeRank, getStats, claimDaily, transferCurrency, getBalance,
    assertSubcommandAllowed, assertChannelAllowed, assertRolesAllowed, OwoGateError,
    listCatalog, RANKS,
} from '../core/owo/manager.js';
import {
    adminGrantCrate, getCrateCount, openCrate,
    listWeapons, describeWeapon,
} from '../core/owo/weapons-service.js';
import { getCounts as getOwoCounts } from '../core/owo/points.js';
import {
    createTeam, renameTeam, listTeams, setActiveTeam,
    ensureDefaultTeam, addAnimalToTeam, removeAnimalFromTeam,
    equipWeapon, unequipWeapon, getTeamDetails, renameAnimal,
} from '../core/owo/teams-service.js';
import { simulateBattle, generateCpuTeam } from '../core/owo/battle-engine.js';
import { renderHunt, renderCrateDrop } from '../core/owo/hunt-text.js';
import { rollDailyDrop } from '../core/owo/daily-drop.js';
import * as lootbox from '../core/owo/lootbox-service.js';
import { listOwned, getActive, use as useGems, gemName } from '../core/owo/gems-service.js';
import { superscript, article } from '../core/owo/gems.js';
import { addCowoncy } from '../core/owo/cowoncy.js';
import {
    ensureQuests, listQuests, claimAllComplete, claimQuest, progressQuest,
} from '../core/owo/quests-service.js';
import pool from '../utils/db.js';
import { formatMoney } from '../core/economy-manager.js';
import { getCurrencyMeta } from '../core/owo/cowoncy.js';
import { owoify } from '../core/owo/owoify.js';
import { PermissionFlagsBits } from 'discord.js';

const WEAR_NAMES_P = { 4: 'Pristine', 3: 'Fine', 2: 'Decent', 1: 'Worn', 0: 'Unknown' };
const RANK_COLOR_P = {
    Common: 0x9E9E9E, Uncommon: 0x4CAF50, Rare: 0x2196F3, Epic: 0x9C27B0,
    Mythical: 0xFF9800, Legendary: 0xF44336, Fabled: 0xE91E63,
};

function prettyName(shortcode) {
    if (!shortcode) return '';
    const bare = shortcode.replace(/^:|:$/g, '').replace(/\d+$/, '');
    return bare.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function gate(ctx, subcommand, { checkChannel = false, checkRoles = false } = {}) {
    if (!ctx.guild) { await ctx.reply('This command only works in servers.'); return false; }
    if (!(await isEnabled(ctx.guildId))) {
        await ctx.reply('🧺 OwO isn\'t enabled here. An admin can run `/owo toggle enabled:True`.');
        return false;
    }
    try {
        await assertSubcommandAllowed(ctx.guildId, subcommand);
        if (checkChannel) await assertChannelAllowed(ctx.guildId, ctx.channelId || ctx.channel?.id);
        if (checkRoles) {
            const roleIds = ctx.member?.roles?.cache
                ? Array.from(ctx.member.roles.cache.keys())
                : (ctx.member?.roles || []);
            await assertRolesAllowed(ctx.guildId, roleIds);
        }
    } catch (e) {
        if (e instanceof OwoGateError) { await ctx.reply(e.message); return false; }
        throw e;
    }
    return true;
}

export async function handleHunt(ctx) {
    if (!(await gate(ctx, 'hunt', { checkChannel: true, checkRoles: true }))) return;
    await ctx.deferReply();
    const result = await hunt(ctx.guildId, ctx.user.id);
    if (result.cooldown) {
        const secs = Math.ceil(result.remainingMs / 1000);
        return ctx.editReply(`⏳ You're still catching your breath — try again in **${secs}s**.`);
    }
    if (result.error) return ctx.editReply(`❌ ${result.error}`);

    // Plain text, not an embed — a hunt is a one-line result and the bot we replace prints it
    // that way. See core/owo/hunt-text.js.
    await ctx.editReply(renderHunt(ctx.user.username, result));
}

export async function handleZoo(ctx) {
    if (!(await gate(ctx, 'zoo'))) return;
    await ctx.deferReply();
    const targetUser = ctx.options.getUser('user') || ctx.user;
    const zoo = await getZoo(ctx.guildId, targetUser.id);

    const rankOrder = Object.keys(RANKS).sort((a, b) => (RANKS[b].order || 0) - (RANKS[a].order || 0));
    const lines = [];
    for (const rank of rankOrder) {
        const animals = zoo.grouped[rank];
        if (!animals?.length) continue;
        lines.push(`**${rank[0].toUpperCase() + rank.slice(1)}** — ${animals.map(a => a.emoji + '×' + a.count).join(' ')}`);
    }
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: `${targetUser.username}'s Zoo`, iconURL: targetUser.displayAvatarURL() })
        .setDescription(lines.length ? lines.join('\n\n') : '*No animals yet — try `owo hunt`!*')
        .setFooter({ text: `${zoo.uniqueAnimals}/${zoo.catalogSize} unique · ${zoo.totalCatches} total · ${zoo.completionPct.toFixed(1)}% complete` });
    await ctx.editReply({ embeds: [embed] });
}

export async function handleLeaderboard(ctx) {
    if (!(await gate(ctx, 'leaderboard'))) return;
    await ctx.deferReply();
    const rows = await getLeaderboard(ctx.guildId, 10);
    if (!rows.length) return ctx.editReply('*No hunters yet.*');
    const medals = ['🥇','🥈','🥉'];
    const lines = rows.map((r, i) => `${medals[i] || `\`#${i + 1}\``} <@${r.user_id}> — **${r.total.toLocaleString()}** catches · ${r.unique_animals} unique`);
    const embed = new EmbedBuilder().setColor(0xF0A500).setTitle('🏆 OwO Hunt Leaderboard').setDescription(lines.join('\n'));
    await ctx.editReply({ embeds: [embed], allowedMentions: { users: [] } });
}

export async function handleCatalog(ctx) {
    if (!(await gate(ctx, 'catalog'))) return;
    await ctx.deferReply();
    const cat = await listCatalog();
    const sections = [];
    for (const tier of cat) {
        if (tier.animals.length === 0) continue;
        const items = tier.animals.map(a => `${a.emoji} ${prettyName(a.name)}`).join(' · ');
        sections.push(`**${tier.rank[0].toUpperCase() + tier.rank.slice(1)}** *(${tier.rarity}%)* — ${items}`);
    }
    const embed = new EmbedBuilder().setColor(0xF0A500).setTitle('🐾 OwO Animal Catalog').setDescription(sections.join('\n\n').slice(0, 4000));
    await ctx.editReply({ embeds: [embed] });
}

export async function handleSell(ctx, rankArg) {
    if (!(await gate(ctx, 'sell'))) return;
    await ctx.deferReply();
    const rank = (rankArg || ctx.options.getString('rank') || '').toLowerCase();
    const validRanks = ['common', 'uncommon', 'rare', 'epic', 'mythical', 'legendary'];
    if (!rank || !validRanks.includes(rank)) {
        return ctx.editReply(`Usage: \`owo sell <rank>\` — rank is one of: ${validRanks.join(', ')}`);
    }
    const result = await sellRank(ctx.guildId, ctx.user.id, rank);
    if (result.error) return ctx.editReply(`❌ ${result.error}`);
    if (result.sold === 0) return ctx.editReply(`🪹 You don't have any duplicate **${rank}** animals to sell.`);
    const econ = await getCurrencyMeta(ctx.guildId);
    await ctx.editReply(`💰 Sold **${result.sold}** duplicate ${rank} animals at ${result.pricePer} ${econ.currency_emoji} each — earned ${formatMoney(result.currency, econ)}!`);
}

export async function handleSacrifice(ctx, rankArg) {
    if (!(await gate(ctx, 'sacrifice'))) return;
    await ctx.deferReply();
    const rank = (rankArg || ctx.options.getString('rank') || '').toLowerCase();
    const validRanks = ['common', 'uncommon', 'rare', 'epic', 'mythical', 'legendary'];
    if (!rank || !validRanks.includes(rank)) {
        return ctx.editReply(`Usage: \`owo sacrifice <rank>\` — rank is one of: ${validRanks.join(', ')}`);
    }
    const result = await sacrificeRank(ctx.guildId, ctx.user.id, rank);
    if (result.error) return ctx.editReply(`❌ ${result.error}`);
    if (result.sacrificed === 0) return ctx.editReply(`🪹 You don't have any duplicate **${rank}** animals to sacrifice.`);
    await ctx.editReply(`✨ Sacrificed **${result.sacrificed}** ${rank} animals → **+${result.xp.toLocaleString()} essence** (${result.xpPer} each).`);
}

export async function handleDaily(ctx) {
    if (!(await gate(ctx, 'daily'))) return;
    await ctx.deferReply();
    const result = await claimDaily(ctx.guildId, ctx.user.id).catch(e => ({ error: e.message }));
    if (result.error) return ctx.editReply(`❌ ${result.error}`);
    if (result.cooldown) {
        return ctx.editReply(`⏳ Already claimed your OwO daily — come back in **${result.remainingHours}h ${result.remainingMinutes}m**.`);
    }
    const econ = await getCurrencyMeta(ctx.guildId);
    const amount = result.totalAmount ?? result.reward ?? result.amount ?? 0;
    const streakLine = result.streak > 1
        ? `\n🔥 Streak: **${result.streak} days**${result.streakBonus ? ` (+${result.streakBonus.toLocaleString()} bonus)` : ''}`
        : '';
    await ctx.editReply(`🎁 OwO daily claimed: ${formatMoney(amount, econ)}!${streakLine}`);
}

export async function handleBalance(ctx) {
    if (!(await gate(ctx, 'balance'))) return;
    await ctx.deferReply();
    const wallet = await getBalance(ctx.guildId, ctx.user.id);
    const econ = await getCurrencyMeta(ctx.guildId);
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: ctx.user.username, iconURL: ctx.user.displayAvatarURL() })
        .addFields({ name: 'Wallet', value: formatMoney(wallet, econ), inline: true });
    await ctx.editReply({ embeds: [embed] });
}

export async function handleGive(ctx, { user, amount } = {}) {
    if (!(await gate(ctx, 'give'))) return;
    await ctx.deferReply();
    const recipient = user || ctx.options.getUser('user');
    const amt = parseInt(amount ?? ctx.options.getInteger('amount'), 10);
    if (!recipient || !Number.isFinite(amt) || amt <= 0) return ctx.editReply('Usage: `owo give @user <amount>`');
    if (recipient.id === ctx.user.id) return ctx.editReply('❌ You can\'t give currency to yourself.');
    if (recipient.bot) return ctx.editReply('❌ You can\'t gift currency to a bot.');
    try {
        await transferCurrency(ctx.guildId, ctx.user.id, recipient.id, amt);
    } catch (e) { return ctx.editReply(`❌ ${e.message}`); }
    const econ = await getCurrencyMeta(ctx.guildId);
    await ctx.editReply(`💸 <@${ctx.user.id}> gave ${formatMoney(amt, econ)} to <@${recipient.id}>.`);
}

export async function handleStats(ctx) {
    if (!(await gate(ctx, 'stats'))) return;
    await ctx.deferReply();
    const target = ctx.options.getUser('user') || ctx.user;
    const s = await getStats(ctx.guildId, target.id);
    const econ = await getCurrencyMeta(ctx.guildId);

    const rankOrder = Object.keys(RANKS).sort((a, b) => (RANKS[b].order || 0) - (RANKS[a].order || 0));
    const rankLines = [];
    for (const rank of rankOrder) {
        const r = s.byRank[rank];
        if (!r) continue;
        rankLines.push(`**${rank}** — ${r.total.toLocaleString()} total`);
    }
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: `${target.username}'s OwO Stats`, iconURL: target.displayAvatarURL() })
        .setDescription(rankLines.join('\n') || '*No catches yet.*')
        .addFields(
            { name: 'Unique', value: `${s.uniqueAnimals.toLocaleString()}`, inline: true },
            { name: 'Total', value: `${s.totalCatches.toLocaleString()}`, inline: true },
            { name: 'Wallet', value: formatMoney(s.wallet, econ), inline: true }
        );
    if (s.rarest) {
        embed.addFields({ name: '🏆 Rarest Find', value: `${s.rarest.emoji} **${prettyName(s.rarest.name)}** (${s.rarest.rank})` });
    }
    await ctx.editReply({ embeds: [embed] });
}

export async function handleOwoify(ctx) {
    const text = ctx.options.getString('text');
    if (!text) return ctx.reply('Usage: `owoify <text>`');
    await ctx.reply({ content: owoify(text).slice(0, 2000), allowedMentions: { parse: [] } });
}

export async function handleWeapon(ctx, uwidArg) {
    if (!(await gate(ctx, 'weapon'))) return;
    await ctx.deferReply();
    const uwid = parseInt(uwidArg ?? ctx.options.getInteger('id'), 10);
    if (Number.isFinite(uwid) && uwid > 0) {
        const w = await describeWeapon(ctx.guildId, ctx.user.id, uwid);
        if (!w) return ctx.editReply(`❌ You don't own weapon \`${uwid}\`.`);
        const embed = new EmbedBuilder()
            .setColor(RANK_COLOR_P[w.rank] || 0xF0A500)
            .setTitle(`${w.emoji} ${w.rank} ${w.name}`)
            .setDescription(w.basicDesc || '*A weapon.*')
            .addFields(
                { name: 'Stat', value: String(w.stat), inline: true },
                { name: 'Wear', value: WEAR_NAMES_P[w.wearId] || '?', inline: true },
                { name: 'Favorite', value: w.favorite ? '⭐' : '—', inline: true }
            );
        if (w.passives?.length) {
            embed.addFields({
                name: 'Passives',
                value: w.passives.map(p => `• **${p.name}** (+${p.quality})${p.description ? ` — ${p.description}` : ''}`).join('\n'),
            });
        }
        embed.setFooter({ text: `uwid: ${w.uwid}` });
        return ctx.editReply({ embeds: [embed] });
    }
    const list = await listWeapons(ctx.guildId, ctx.user.id, { limit: 30 });
    if (!list.length) return ctx.editReply('🗡️ You don\'t own any weapons yet. Run `owo crate` to open one!');
    const lines = list.map(w => `\`#${w.uwid}\` ${w.emoji} **${w.rank}** ${w.name} · stat ${w.stat} · ${WEAR_NAMES_P[w.wearId] || '?'}${w.favorite ? ' ⭐' : ''}`);
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: `${ctx.user.username}'s Armory`, iconURL: ctx.user.displayAvatarURL() })
        .setDescription(lines.join('\n').slice(0, 4000))
        .setFooter({ text: `${list.length} weapon${list.length === 1 ? '' : 's'} · owo weapon <#> for details` });
    await ctx.editReply({ embeds: [embed] });
}

export async function handleCrate(ctx) {
    if (!(await gate(ctx, 'crate'))) return;
    await ctx.deferReply();
    const count = await getCrateCount(ctx.guildId, ctx.user.id);
    if (count < 1) return ctx.editReply('📦 You don\'t have any crates. Ask an admin for one.');
    try {
        const { weapon, cratesLeft } = await openCrate(ctx.guildId, ctx.user.id);
        const embed = new EmbedBuilder()
            .setColor(RANK_COLOR_P[weapon.rank] || 0xF0A500)
            .setTitle(`📦 Crate opened! ${weapon.emoji} ${weapon.rank} ${weapon.name}`)
            .setDescription(weapon.basicDesc || '*A new weapon joins your armory.*')
            .addFields(
                { name: 'Stat', value: String(weapon.stat), inline: true },
                { name: 'Wear', value: WEAR_NAMES_P[weapon.wearId] || 'Worn', inline: true },
                { name: 'Rank', value: weapon.rank, inline: true }
            );
        if (weapon.passives?.length) {
            embed.addFields({
                name: 'Passives',
                value: weapon.passives.map(p => `• **${p.name}** (+${p.quality})`).join('\n'),
            });
        }
        embed.setFooter({ text: `uwid: ${weapon.uwid} · ${cratesLeft} crate${cratesLeft === 1 ? '' : 's'} left` });
        await ctx.editReply({ embeds: [embed] });
    } catch (e) {
        await ctx.editReply(`❌ ${e.message}`);
    }
}

export async function handleGrantCrate(ctx, { user, count } = {}) {
    if (!ctx.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)) {
        return ctx.reply('You need **Manage Server** to grant crates.');
    }
    await ctx.deferReply();
    const target = user || ctx.options.getUser('user');
    const n = parseInt(count ?? ctx.options.getInteger('count') ?? 1, 10);
    if (!target || target.bot) return ctx.editReply('Usage: `owo grant-crate @user [count]`');
    await adminGrantCrate(ctx.guildId, target.id, n);
    const total = await getCrateCount(ctx.guildId, target.id);
    await ctx.editReply(`✅ Granted **${n}** crate${n === 1 ? '' : 's'} to <@${target.id}>. Total: **${total}**.`);
}

// Read a positional-style argument from the message content when the ctx
// adapter doesn't expose a named option. Falls back to ctx.options.getString
// trying multiple common names.
function readArg(ctx, ...optionNames) {
    for (const n of optionNames) {
        const v = ctx.options.getString?.(n);
        if (v != null && String(v).length) return String(v);
        const i = ctx.options.getInteger?.(n);
        if (i != null) return String(i);
    }
    return null;
}

function normAnimal(s) {
    if (!s) return '';
    const t = s.trim().toLowerCase().replace(/\s+/g, '_');
    return /^:.+:$/.test(t) ? t : `:${t}:`;
}

export async function handleTeamView(ctx) {
    if (!(await gate(ctx, 'team'))) return;
    await ctx.deferReply();
    const pgidArg = readArg(ctx, 'pgid', 'amount');
    const pgid = pgidArg ? parseInt(pgidArg, 10) : null;
    const team = await getTeamDetails(ctx.guildId, ctx.user.id, pgid);
    if (!team) return ctx.editReply('🗡️ No team yet. Use `/owo team-add <animal>` to create one.');
    const lines = team.animals.length
        ? team.animals.map(a => {
            const nick = a.nickname ? ` *(${a.nickname})*` : '';
            const wep = a.weapon ? ` — ${a.weapon.emoji} ${a.weapon.rank} ${a.weapon.name}` : '';
            return `**${a.pos}.** ${a.name}${nick} [${a.rank}] HP${a.stats.hp} ATT${a.stats.att}${wep}`;
        }).join('\n')
        : '*Empty.*';
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: `${ctx.user.username}'s team`, iconURL: ctx.user.displayAvatarURL() })
        .setTitle(`⚔️ ${team.tname}`)
        .setDescription(lines)
        .setFooter({ text: `pgid: ${team.pgid} · ${team.win}W / ${team.lose}L · streak ${team.streak}` });
    await ctx.editReply({ embeds: [embed] });
}

/**
 * The rest of `owo team …` from chat. These existed only as slash subcommands, so `owo team
 * rename` did nothing useful — yet renaming is visible in every battle embed, and people plainly
 * used it. `owo team <action>` is folded into these by core/owo-natural-prefix.js.
 */
export async function handleTeamCreate(ctx) {
    if (!(await gate(ctx, 'team-create'))) return;
    await ctx.deferReply();
    const name = readArg(ctx, 'name', 'text') || null;
    const r = await createTeam(ctx.guildId, ctx.user.id, name);
    if (r.error) return ctx.editReply(`❌ ${r.error}`);
    await ctx.editReply(`✅ Created team **${r.tname}** (id \`${r.pgid}\`).`);
}

export async function handleTeamRemove(ctx) {
    if (!(await gate(ctx, 'team-remove'))) return;
    await ctx.deferReply();
    const pos = parseInt(readArg(ctx, 'pos', 'rank', 'amount'), 10);
    if (!Number.isFinite(pos)) return ctx.editReply('Usage: `owo team remove <position>`');
    const pgid = await ensureDefaultTeam(ctx.guildId, ctx.user.id);
    const r = await removeAnimalFromTeam(ctx.guildId, ctx.user.id, pgid, pos);
    if (r.error) return ctx.editReply(`❌ ${r.error}`);
    await ctx.editReply(`✅ Removed the animal at position **${pos}**.`);
}

export async function handleTeamSwitch(ctx) {
    if (!(await gate(ctx, 'team-switch'))) return;
    await ctx.deferReply();
    const pgid = parseInt(readArg(ctx, 'pgid', 'rank', 'amount'), 10);
    if (!Number.isFinite(pgid)) return ctx.editReply('Usage: `owo team switch <team id>`');
    const r = await setActiveTeam(ctx.guildId, ctx.user.id, pgid);
    if (r?.error) return ctx.editReply(`❌ ${r.error}`);
    await ctx.editReply(`✅ Team \`${pgid}\` is now your active team.`);
}

export async function handleTeamRename(ctx) {
    if (!(await gate(ctx, 'team-rename'))) return;
    await ctx.deferReply();
    // `owo team rename 3 Win ov hg` — first token is the id, the rest is the name (spaces and all).
    const tokens = (readArg(ctx, 'text') || '').split(/\s+/).filter(Boolean);
    const pgid = parseInt(tokens[0], 10);
    const name = tokens.slice(1).join(' ');
    if (!Number.isFinite(pgid) || !name) {
        return ctx.editReply('Usage: `owo team rename <team id> <new name>`');
    }
    const r = await renameTeam(ctx.guildId, ctx.user.id, pgid, name);
    if (r?.error) return ctx.editReply(`❌ ${r.error}`);
    await ctx.editReply(`✅ Team \`${pgid}\` is now **${name}**.`);
}

export async function handleTeamAdd(ctx) {
    if (!(await gate(ctx, 'team-add'))) return;
    await ctx.deferReply();
    const animal = normAnimal(readArg(ctx, 'animal', 'rank', 'text'));
    if (!animal) return ctx.editReply('Usage: `owo team-add <animal>`');
    const pgid = await ensureDefaultTeam(ctx.guildId, ctx.user.id);
    const r = await addAnimalToTeam(ctx.guildId, ctx.user.id, pgid, animal);
    if (r.error) return ctx.editReply(`❌ ${r.error}`);
    await ctx.editReply(`✅ Added \`${r.animalName}\` to team at position **${r.pos}**.`);
}

export async function handleQuestPrefix(ctx) {
    if (!(await gate(ctx, 'quest'))) return;
    await ctx.deferReply();
    const action = (readArg(ctx, 'action', 'rank') || '').toLowerCase();
    const slotStr = readArg(ctx, 'slot', 'amount');
    const slot = slotStr ? parseInt(slotStr, 10) : null;
    const econ = await getCurrencyMeta(ctx.guildId);
    const cmoji = econ.currency_emoji || '💰';

    if (action === 'claim-all' || action === 'claimall') {
        const results = await claimAllComplete(ctx.guildId, ctx.user.id);
        if (!results.length) return ctx.editReply('🪹 No completed quests to claim.');
        const lines = results.map(r => `• **${r.qname}** → ${r.reward} ${r.rewardType === 'cowoncy' ? cmoji : r.rewardType}`);
        return ctx.editReply(`🎉 Claimed ${results.length} quest${results.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
    }
    if (Number.isFinite(slot)) {
        const r = await claimQuest(ctx.guildId, ctx.user.id, slot);
        if (r.error) return ctx.editReply(`❌ ${r.error}`);
        await ensureQuests(ctx.guildId, ctx.user.id);
        return ctx.editReply(`🎉 Claimed slot ${slot}: **${r.reward}** ${r.rewardType === 'cowoncy' ? cmoji : r.rewardType}!`);
    }
    await ensureQuests(ctx.guildId, ctx.user.id);
    const qs = await listQuests(ctx.guildId, ctx.user.id);
    if (!qs.length) return ctx.editReply('📋 No active quests.');
    const lines = qs.map(q => {
        const bar = '█'.repeat(Math.floor(q.progressPct / 10)) + '░'.repeat(10 - Math.floor(q.progressPct / 10));
        const emj = { cowoncy: cmoji, crate: '📦', shards: '💠', lootbox: '🎁' }[q.prize] || '🎁';
        const status = q.complete ? '✅ **claimable**' : `${bar} ${q.count}/${q.target}`;
        return `**\`${q.qid}\` ${q.description}** — ${status}  reward: ${q.reward} ${emj}`;
    });
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: `${ctx.user.username}'s Quests`, iconURL: ctx.user.displayAvatarURL() })
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Claim: owo quest <slot> · owo quest claim-all' });
    await ctx.editReply({ embeds: [embed] });
}

export async function handleBattlePrefix(ctx) {
    if (!(await gate(ctx, 'battle'))) return;
    await ctx.deferReply();
    const opponent = ctx.options.getUser?.('user') || ctx.options.getUser?.('opponent');
    const player = await getTeamDetails(ctx.guildId, ctx.user.id);
    if (!player || player.animals.length === 0) return ctx.editReply('🗡️ Build a team first with `owo team-add <animal>`.');
    let enemy, isPvP = false;
    if (opponent) {
        if (opponent.id === ctx.user.id) return ctx.editReply('❌ You can\'t battle yourself.');
        if (opponent.bot) return ctx.editReply('❌ Can\'t battle a bot.');
        enemy = await getTeamDetails(ctx.guildId, opponent.id);
        if (!enemy || enemy.animals.length === 0) return ctx.editReply(`❌ <@${opponent.id}> doesn't have a team yet.`);
        isPvP = true;
    } else {
        enemy = await generateCpuTeam(player);
    }
    const result = simulateBattle(player, enemy);
    const econ = await getCurrencyMeta(ctx.guildId);
    const playerWon = result.winner === 'team1';
    const playerLost = result.winner === 'team2';
    try {
        if (playerWon) await pool.execute('UPDATE owo_pet_team SET win = win + 1, streak = streak + 1, highest_streak = GREATEST(highest_streak, streak + 1) WHERE guild_id=? AND uid=? AND pgid=?', [ctx.guildId, ctx.user.id, player.pgid]);
        else if (playerLost) await pool.execute('UPDATE owo_pet_team SET lose = lose + 1, streak = 0 WHERE guild_id=? AND uid=? AND pgid=?', [ctx.guildId, ctx.user.id, player.pgid]);
    } catch { /* ignore */ }
    let reward = 0;
    if (playerWon) { reward = 25 + Math.floor(Math.random() * 50); try { await addCowoncy(ctx.guildId, ctx.user.id, reward, 'OwO battle win'); } catch {} }
    const color = playerWon ? 0x4CAF50 : (playerLost ? 0xF44336 : 0x9E9E9E);
    const resultLine = playerWon ? `🏆 **Victory!** +${reward} ${econ.currency_emoji || '💰'}` : (playerLost ? '💀 **Defeat.**' : '🤝 **Draw.**');
    const logText = result.log.join('\n').slice(0, 3000);

    // Team-vs-team, the way the bot we replace shows it: the two rosters as side-by-side fields
    // under a "<name> goes into battle!" author line, rather than buried in the log text.
    const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: `${ctx.user.username} goes into battle!`, iconURL: ctx.user.displayAvatarURL() })
        .setDescription(resultLine + '\n\n' + logText)
        .addFields(
            { name: player.tname || `${ctx.user.username}'s Team`, value: rosterField(player), inline: true },
            { name: enemy.tname || 'Enemy Team', value: rosterField(enemy), inline: true },
        )
        .setFooter({ text: `Turns: ${result.turns}` });

    await ctx.editReply({ embeds: [embed] });

    // A battle can drop a weapon crate — first one after midnight is guaranteed, then 5%, 3/day.
    const crate = await rollDailyDrop('crate', ctx.guildId, ctx.user.id);
    const crateText = renderCrateDrop(ctx.user.username, crate);
    if (crateText) await ctx.followUp(crateText).catch(() => {});
}

/** One roster as an embed field: "🐊 Snappy — 120 HP". */
function rosterField(team) {
    const lines = (team.animals ?? []).map(a => {
        const label = a.nickname || prettyName(a.name);
        return `${a.emoji ?? ''} ${label}${a.hp ? ` — ${a.hp} HP` : ''}`.trim();
    });
    return lines.length ? lines.join('\n').slice(0, 1020) : '—';
}

export async function handleEquipPrefix(ctx) {
    if (!(await gate(ctx, 'equip'))) return;
    await ctx.deferReply();
    const posStr = readArg(ctx, 'pos', 'rank');
    const uwidStr = readArg(ctx, 'uwid', 'amount');
    const pos = parseInt(posStr, 10);
    const uwid = parseInt(uwidStr, 10);
    if (!Number.isFinite(pos) || !Number.isFinite(uwid)) return ctx.editReply('Usage: `owo equip <pos> <uwid>`');
    const pgid = await ensureDefaultTeam(ctx.guildId, ctx.user.id);
    const r = await equipWeapon(ctx.guildId, ctx.user.id, pgid, pos, uwid);
    if (r.error) return ctx.editReply(`❌ ${r.error}`);
    await ctx.editReply(`✅ Equipped weapon #${uwid} to position **${pos}**.`);
}

/** `owo count` — how many times you've said owo/uwu. */
/**
 * `owo lootbox [n|all]` — open lootboxes for gems.
 *
 * Two messages, as upstream does it: the box shakes, then three seconds later it opens. The
 * suspense IS the feature; opening instantly reads as a different game.
 */
export async function handleLootbox(ctx) {
    if (!(await gate(ctx, 'lootbox'))) return;
    await ctx.deferReply();

    const arg = (readArg(ctx, 'count', 'rank') || '').toLowerCase();
    const all = arg === 'all';
    const n = parseInt(arg, 10);

    const result = all
        ? await lootbox.openAll(ctx.guildId, ctx.user.id)
        : await lootbox.open(ctx.guildId, ctx.user.id, Number.isFinite(n) && n > 0 ? n : 1);

    if (result.error) return ctx.editReply(`❌ ${result.error}`);

    const name = ctx.user.username;
    const many = result.opened > 1;
    const opening = many
        ? `**▫️ | ${name}** opens ${result.opened} lootboxes\n**🫨 |** and finds...`
        : `**▫️ | ${name}** opens a lootbox\n**🫨 |** and finds a ...`;

    const msg = await ctx.editReply(opening);

    const reveal = many
        ? `**▫️ | ${name}** opens ${result.opened} lootboxes\n**📭 |** and finds: `
          + result.gems.map(g => `${g.gem.emoji}${superscript(g.count)}`).join(' ')
        : (() => {
            const g = result.gems[0].gem;
            return `${g.emoji} **| ${name}** opens a lootbox\n`
                + `**📭 |** and finds ${article(g)} **${gemName(g)}**!`;
        })();

    setTimeout(() => {
        (msg?.edit ? msg.edit(reveal) : ctx.editReply(reveal))?.catch?.(() => {});
    }, 3000);
}

/** `owo gems` — what you own and what is running. */
export async function handleGems(ctx) {
    if (!(await gate(ctx, 'gems'))) return;
    await ctx.deferReply();

    const [owned, active] = await Promise.all([
        listOwned(ctx.guildId, ctx.user.id),
        getActive(ctx.guildId, ctx.user.id),
    ]);

    const activeLines = Object.values(active)
        .map(g => `${g.emoji} **${gemName(g)}** — \`[${g.activecount}/${g.length}]\` uses left`);
    const ownedLines = owned
        .map(g => `\`${String(g.id).padStart(2)}\` ${g.emoji} **${gemName(g)}** ×${g.count}`);

    const embed = new EmbedBuilder()
        .setColor(0x8E7CC3)
        .setAuthor({ name: `${ctx.user.username}'s gems`, iconURL: ctx.user.displayAvatarURL() })
        .setDescription(
            (activeLines.length ? `**Active**\n${activeLines.join('\n')}\n\n` : '')
            + (ownedLines.length ? `**Inventory**\n${ownedLines.join('\n')}` : '*No gems — hunt for lootboxes.*')
        )
        .setFooter({ text: 'Activate with: owo use <id> — one gem per type at a time' });

    await ctx.editReply({ embeds: [embed] });
}

/** `owo use <id> [id...]` — activate gems. */
export async function handleUseGem(ctx) {
    if (!(await gate(ctx, 'use'))) return;
    await ctx.deferReply();

    // `text` carries every token, so `owo use 52 61` activates both; `id` covers the slash path.
    const raw = (readArg(ctx, 'text') || readArg(ctx, 'id') || '')
        .split(/[\s,]+/)
        .map(v => parseInt(v, 10))
        .filter(Number.isFinite);

    const ids = [...new Set(raw)];
    const result = await useGems(ctx.guildId, ctx.user.id, ids);
    if (result.error) return ctx.editReply(`❌ ${result.error}`);

    const list = result.activated
        .map(g => `${g.emoji} **${gemName(g)}** \`[${g.length}/${g.length}]\``)
        .join('\n');
    await ctx.editReply(`✅ Activated:\n${list}`);
}

export async function handleOwoCount(ctx) {
    const target = ctx.options.getUser?.('user') || ctx.user;
    const c = await getOwoCounts(ctx.guildId, target.id);
    const embed = new EmbedBuilder()
        .setColor(0xFF7BAC)
        .setTitle(`${target.username}'s owo count`)
        .setDescription(
            `**${c.server.toLocaleString()}** here (rank **#${c.rank}**)\n` +
            `**${c.global.toLocaleString()}** across every server\n\n` +
            `_This server has said owo **${c.guildTotal.toLocaleString()}** times._`
        )
        .setFooter({ text: 'Say owo or uwu anywhere to earn a point (once per 10s).' });
    return ctx.reply({ embeds: [embed] });
}

export async function handleOwoRouter(ctx) {
    const subcommand = (ctx.options.getString('subcommand') || 'hunt').toLowerCase();
    // Bump the 'owo' quest for every routed subcommand (mirror the slash
    // dispatcher). Fire-and-forget.
    if (ctx.guildId && ctx.user?.id) {
        progressQuest(ctx.guildId, ctx.user.id, 'owo', 1).catch(() => {});
    }
    switch (subcommand) {
        case 'hunt': case 'h': case 'catch':         return handleHunt(ctx);
        case 'zoo':                                   return handleZoo(ctx);
        case 'leaderboard': case 'top':              return handleLeaderboard(ctx);
        case 'catalog': case 'dex':                  return handleCatalog(ctx);
        case 'sell':                                  return handleSell(ctx);
        case 'sacrifice': case 'sac':                return handleSacrifice(ctx);
        case 'daily':                                 return handleDaily(ctx);
        case 'balance': case 'bal': case 'money': case 'cowoncy': return handleBalance(ctx);
        case 'give': case 'gift':                    return handleGive(ctx);
        case 'stats':                                 return handleStats(ctx);
        case 'owoify':                                return handleOwoify(ctx);
        case 'weapon': case 'w': case 'weapons': case 'wep': return handleWeapon(ctx);
        case 'crate': case 'weaponcrate': case 'wc': return handleCrate(ctx);
        case 'lootbox': case 'lb': case 'box':        return handleLootbox(ctx);
        case 'gems': case 'gem':                      return handleGems(ctx);
        case 'use':                                   return handleUseGem(ctx);
        case 'grant-crate': case 'grantcrate':        return handleGrantCrate(ctx);
        case 'team': case 'squad':                    return handleTeamView(ctx);
        case 'team-add': case 'teamadd':              return handleTeamAdd(ctx);
        case 'team-create':                           return handleTeamCreate(ctx);
        case 'team-remove':                           return handleTeamRemove(ctx);
        case 'team-switch':                           return handleTeamSwitch(ctx);
        case 'team-rename':                           return handleTeamRename(ctx);
        case 'equip':                                  return handleEquipPrefix(ctx);
        case 'battle': case 'b': case 'fight':        return handleBattlePrefix(ctx);
        case 'quest': case 'quests': case 'q':        return handleQuestPrefix(ctx);
        case 'count': case 'points':                  return handleOwoCount(ctx);
        case 'help':  // falls through to the command list
        default:
            return ctx.reply(
                '**OwO subcommands:** `hunt`, `zoo`, `leaderboard`, `catalog`, `sell <rank>`, `sacrifice <rank>`, `daily`, `balance`, `give @user <amt>`, `stats`, `owoify <text>`, `weapon [id]`, `crate`, `grant-crate @user [n]`'
            );
    }
}
