/*
 * OwO social & economy front-end — shared by the `/owo2` slash command (commands/fun/owo2.js) and
 * the chat prefix router (handlers/owo-prefix.js), so both print the same thing.
 * CC-BY-NC-SA-4.0 derivative file. See /LICENSE-OWO-NOTICE.md. Message wording follows upstream
 * OwO Bot (Christopher Thai): social/pray.js, social/cookie.js, gamble/lottery.js, gamble/drop.js,
 * social/marry.js, acceptMarriage.js, declineMarriage.js, divorce.js, social/wallpaper.js,
 * shop/*, battle/battleSetting.js.
 *
 * Every function takes a ctx (a ChatInputCommandInteraction or core/message-context-adapter.js's
 * MessageContextAdapter) plus already-parsed arguments. Gating (module enabled, disabled
 * subcommands) is the caller's job.
 */
import {
    EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, PermissionFlagsBits,
} from 'discord.js';
import { displayNameFor } from '../utils/display-name.js';
import { userMessage } from '../core/owo/tx.js';
import * as social from '../core/owo/social-service.js';
import * as lottery from '../core/owo/lottery-service.js';
import * as drops from '../core/owo/drop-service.js';
import * as wallpapers from '../core/owo/wallpaper-service.js';
import * as marriage from '../core/owo/marriage-service.js';
import { getLimitStatus, listTransactions, FLOOR_ID } from '../core/owo/give-limits.js';
import { getBattleSettings, setBattleSetting, answerPendingChallenge } from '../core/owo/battle-pvp.js';
import { renderWallpaperPreview } from '../core/owo/profile-card.js';
import { buildProfileMessage } from '../core/owo/profile-view.js';
import { getCowoncy } from '../core/owo/cowoncy.js';
import {
    RINGS, ringSellPrice, resolveShopId, parseBattleSetting, LOTTERY_MAX_BET, WALLPAPER_SHOP_OFFSET, colorInt,
} from '../core/owo/social-math.js';

const CASH = '💵';
const BLANK = '▫️';
const NO_PINGS = { parse: [] };
const fmt = n => Number(n).toLocaleString('en-US');
const nameOf = (ctx, user) => displayNameFor(user, ctx.guild);
const unix = d => Math.floor(new Date(d).getTime() / 1000);

async function ensureDeferred(ctx) {
    if (!ctx.deferred && !ctx.replied) await ctx.deferReply();
}

function fail(ctx, err, op) {
    return ctx.editReply({
        content: `❌ ${userMessage(err, { guildId: ctx.guildId, userId: ctx.user?.id, op })}`,
        embeds: [], components: [], allowedMentions: NO_PINGS,
    });
}

function isManager(ctx) {
    return !!(ctx.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)
        || ctx.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
}

/**
 * Yes/No buttons on the reply; resolves true / false, or null on timeout. Only `ctx.user` can answer.
 */
async function askConfirm(ctx, payload, { yes = 'Confirm', no = 'Cancel', timeoutMs = 60_000 } = {}) {
    const yesId = `owo_confirm_yes:${ctx.id}`;
    const noId = `owo_confirm_no:${ctx.id}`;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(yesId).setLabel(yes).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(noId).setLabel(no).setStyle(ButtonStyle.Secondary),
    );
    const msg = await ctx.editReply({ ...payload, components: [row], allowedMentions: NO_PINGS });
    try {
        const button = await msg.awaitMessageComponent({
            componentType: ComponentType.Button,
            time: timeoutMs,
            filter: (i) => {
                if (i.customId !== yesId && i.customId !== noId) return false;
                if (i.user.id !== ctx.user.id) {
                    i.reply({ content: "This isn't your decision to make!", ephemeral: true }).catch(() => {});
                    return false;
                }
                return true;
            },
        });
        await button.deferUpdate().catch(() => {});
        return button.customId === yesId;
    } catch {
        return null; // timed out
    }
}

// ── Pray / curse / cookies / rankings ───────────────────────────────────────

/** `owo pray [@user]` / `owo curse [@user]` */
export async function prayCmd(ctx, kind, target = null) {
    await ensureDeferred(ctx);
    if (target?.bot) return ctx.editReply(`❌ You can't ${kind} a bot, silly!`);
    try {
        const r = await social.prayOrCurse(ctx.guildId, ctx.user.id, target?.id ?? null, kind);
        const me = nameOf(ctx, ctx.user);
        const them = r.target ? nameOf(ctx, target) : null;
        let text;
        if (kind === 'pray') text = them ? `**🙏 | ${me}** prays for **${them}**! ${r.line}` : `**🙏 | ${me}** prays... ${r.line}`;
        else text = them ? `**👻 | ${me}** puts a curse on **${them}**! ${r.line}` : `**👻 | ${me}** is now cursed. ${r.line}`;
        text += `\n**${BLANK} |** You have **${fmt(r.luck)}** luck point${Math.abs(r.luck) === 1 ? '' : 's'}!`;
        return ctx.editReply({ content: text, allowedMentions: NO_PINGS });
    } catch (e) {
        return fail(ctx, e, kind);
    }
}

/** `owo cookie` (status) / `owo cookie @user` (give today's cookie) */
export async function cookieCmd(ctx, target = null) {
    await ensureDeferred(ctx);
    const me = nameOf(ctx, ctx.user);
    try {
        if (!target) {
            const s = await social.cookieStatus(ctx.guildId, ctx.user.id);
            return ctx.editReply({
                content: `**🍪 | ${me}**! You currently have **${fmt(s.count)}** cookie${s.count === 1 ? '' : 's'}! Yummy! c:<\n`
                    + `**${BLANK} |** ${s.ready ? 'You have one cookie to send!' : `You can send a cookie in **${s.waitText}**!`}`,
                allowedMentions: NO_PINGS,
            });
        }
        if (target.bot) return ctx.editReply("❌ Bots can't eat cookies!");
        await social.giveCookie(ctx.guildId, ctx.user.id, target.id);
        return ctx.editReply({
            content: `**🍪 | ${nameOf(ctx, target)}**! You got a cookie from **${me}**! *nom nom nom c:<*`,
            allowedMentions: NO_PINGS,
        });
    } catch (e) {
        return fail(ctx, e, 'cookie');
    }
}

const TOP_META = {
    cookies: { title: '🍪 Top cookie collectors', unit: 'cookies' },
    luck: { title: '🍀 Luckiest members', unit: 'luck' },
    curse: { title: '👻 Most cursed members', unit: 'luck' },
};

/** `owo top cookie|luck|curse` */
export async function topSocialCmd(ctx, type) {
    await ensureDeferred(ctx);
    try {
        const { rows, you } = await social.getSocialLeaderboard(ctx.guildId, type, ctx.user.id);
        const meta = TOP_META[type];
        const medals = ['🥇', '🥈', '🥉'];
        const lines = rows.map((r, i) => `${medals[i] || `\`#${i + 1}\``} <@${r.userId}> — **${fmt(r.value)}** ${meta.unit}`);
        const embed = new EmbedBuilder()
            .setColor(0xF0A500)
            .setTitle(meta.title)
            .setDescription(lines.length ? lines.join('\n') : '*Nobody here yet.*')
            .setFooter({ text: you ? `Your rank: #${you.rank} · ${fmt(you.value)} ${meta.unit}` : 'You are not ranked yet.' });
        return ctx.editReply({ embeds: [embed], allowedMentions: NO_PINGS });
    } catch (e) {
        return fail(ctx, e, 'top');
    }
}

// ── Lottery ─────────────────────────────────────────────────────────────────

/**
 * `owo lottery` (status) / `owo lottery <amount|all>`
 * @param {number|'all'|null} amount
 */
export async function lotteryCmd(ctx, amount = null) {
    await ensureDeferred(ctx);
    const me = nameOf(ctx, ctx.user);
    const box = v => '```fix\n' + v + '```';
    try {
        if (amount == null) {
            const s = await lottery.lotteryStatus(ctx.guildId, ctx.user.id);
            const embed = new EmbedBuilder()
                .setColor(0x4A90E2)
                .setAuthor({ name: `${me}'s Lottery Status`, iconURL: ctx.user.displayAvatarURL?.() })
                .setDescription(`The lottery is drawn every day at midnight! Good luck!\nEnter with \`owo lottery <amount>\` — up to ${fmt(LOTTERY_MAX_BET)} cowoncy per round.`)
                .addFields(
                    { name: 'Your Total Submission', value: box(`${fmt(s.bet)} Cowoncy`), inline: true },
                    { name: 'Winning Chance', value: box(`${s.chance}%`), inline: true },
                    { name: 'Number of Risk Takers', value: box(`${fmt(s.players)} users`), inline: true },
                    { name: 'Current Jackpot', value: box(`${fmt(s.jackpot)} Cowoncy`), inline: true },
                    { name: 'Ends', value: `<t:${unix(s.drawAt)}:R>`, inline: true },
                )
                .setFooter({ text: '*Percentage and jackpot may change over time' });
            if (s.last) {
                embed.addFields({ name: 'Last draw', value: `<@${s.last.winner}> won **${fmt(s.last.pot)}** ${CASH} (${s.last.players} players)` });
            }
            return ctx.editReply({ embeds: [embed], allowedMentions: NO_PINGS });
        }
        const r = await lottery.enterLottery(ctx.guildId, ctx.user.id, amount === 'all' ? null : amount, ctx.channelId ?? ctx.channel?.id);
        const embed = new EmbedBuilder()
            .setColor(0xF0A500)
            .setAuthor({ name: `${me}'s Lottery Submission`, iconURL: ctx.user.displayAvatarURL?.() })
            .setDescription(`Lottery ends once a day! The maximum lottery submission is ${fmt(LOTTERY_MAX_BET)} cowoncy!`
                + (r.capped ? `\n*Your bet was trimmed to fit the ${fmt(LOTTERY_MAX_BET)} limit.*` : ''))
            .addFields(
                { name: 'You added', value: box(`${fmt(r.added)} Cowoncy`), inline: true },
                { name: 'Your Total Submission', value: box(`${fmt(r.total)} Cowoncy`), inline: true },
                { name: 'Winning Chance', value: box(`${r.chance}%`), inline: true },
                { name: 'Current Jackpot', value: box(`${fmt(r.jackpot)} Cowoncy`), inline: true },
                { name: 'Ends', value: `<t:${unix(r.drawAt)}:R>`, inline: true },
            )
            .setFooter({ text: '*Percentage and jackpot may change over time' })
            .setTimestamp(new Date());
        return ctx.editReply({ embeds: [embed], allowedMentions: NO_PINGS });
    } catch (e) {
        return fail(ctx, e, 'lottery');
    }
}

// ── Drops ───────────────────────────────────────────────────────────────────

export async function dropCmd(ctx, amount) {
    await ensureDeferred(ctx);
    if (!Number.isSafeInteger(amount) || amount <= 0) return ctx.editReply('❌ Please specify the drop amount! `owo drop <amount>`');
    try {
        await drops.dropCowoncy(ctx.guildId, ctx.user.id, ctx.channelId ?? ctx.channel?.id, amount);
        return ctx.editReply({
            content: `**💰 | ${nameOf(ctx, ctx.user)}** dropped **${fmt(amount)}** cowoncy!\n**${BLANK} |** Use \`owo pickup <amount>\` to pick it up!`,
            allowedMentions: NO_PINGS,
        });
    } catch (e) {
        return fail(ctx, e, 'drop');
    }
}

export async function pickupCmd(ctx, amount) {
    await ensureDeferred(ctx);
    if (!Number.isSafeInteger(amount) || amount <= 0) return ctx.editReply('❌ Please specify the pickup amount! `owo pickup <amount>`');
    try {
        await drops.pickupCowoncy(ctx.guildId, ctx.user.id, ctx.channelId ?? ctx.channel?.id, amount);
        return ctx.editReply({ content: `**${CASH} | ${nameOf(ctx, ctx.user)}**, you picked up **${fmt(amount)} cowoncy**!`, allowedMentions: NO_PINGS });
    } catch (e) {
        return fail(ctx, e, 'pickup');
    }
}

// ── Give limits / audit log ─────────────────────────────────────────────────

export async function limitsCmd(ctx) {
    await ensureDeferred(ctx);
    try {
        const s = await getLimitStatus(ctx.guildId, ctx.user.id);
        const embed = new EmbedBuilder()
            .setColor(0xF0A500)
            .setAuthor({ name: `${nameOf(ctx, ctx.user)}'s daily cowoncy limits`, iconURL: ctx.user.displayAvatarURL?.() })
            .setDescription(`Limits grow with your server level (you are level **${s.level}**). They cover \`owo give\`, battle bets and drops.`)
            .addFields(
                { name: 'Sent today', value: `${fmt(s.send.used)} / ${fmt(s.send.limit)} ${CASH}`, inline: true },
                { name: 'Received today', value: `${fmt(s.receive.used)} / ${fmt(s.receive.limit)} ${CASH}`, inline: true },
                { name: 'Resets in', value: s.resetsIn, inline: true },
            );
        return ctx.editReply({ embeds: [embed] });
    } catch (e) {
        return fail(ctx, e, 'limits');
    }
}

/**
 * Transfer audit log. Your own transfers for anyone; another member's or the whole server's
 * (`all`) needs Manage Server.
 */
export async function transactionsCmd(ctx, { target = null, all = false } = {}) {
    await ensureDeferred(ctx);
    const forOther = all || (target && target.id !== ctx.user.id);
    if (forOther && !isManager(ctx)) return ctx.editReply("❌ You need **Manage Server** to see other members' transfers.");
    try {
        const rows = await listTransactions(ctx.guildId, { userId: all ? null : (target?.id ?? ctx.user.id), limit: 15 });
        const who = id => (id === FLOOR_ID ? '🧹 *floor*' : `<@${id}>`);
        const lines = rows.map(r => `\`#${r.tid}\` <t:${unix(r.time)}:R> ${who(r.sender)} → ${who(r.receiver)} **${fmt(r.amount)}** ${CASH}`);
        const scope = all ? 'this server' : (target ? nameOf(ctx, target) : nameOf(ctx, ctx.user));
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`💳 Cowoncy transfers — ${scope}`)
            .setDescription(lines.length ? lines.join('\n') : '*No transfers yet.*')
            .setFooter({ text: 'Latest 15 · gives, battle bets, drops and pickups' });
        return ctx.editReply({ embeds: [embed], allowedMentions: NO_PINGS });
    } catch (e) {
        return fail(ctx, e, 'transactions');
    }
}

// ── Battle settings / text answers ──────────────────────────────────────────

/**
 * `owo battlesetting` (show) / `owo battlesetting display=compact`, or slash options.
 * @param {{raw?: string, display?: string, speed?: string, logs?: boolean}} change
 */
export async function battleSettingsCmd(ctx, change = {}) {
    await ensureDeferred(ctx);
    try {
        const updates = [];
        if (change.raw) {
            const parsed = parseBattleSetting(change.raw);
            if (parsed.error) return ctx.editReply(`❌ ${parsed.error}`);
            updates.push(parsed);
        }
        if (change.display) updates.push({ field: 'display', value: change.display });
        if (change.speed) updates.push({ field: 'speed', value: { instant: 0, short: 1, lengthy: 2 }[change.speed] ?? 0 });
        if (typeof change.logs === 'boolean') updates.push({ field: 'logs', value: change.logs ? 1 : 0 });
        let s = await getBattleSettings(ctx.guildId, ctx.user.id);
        for (const u of updates) s = await setBattleSetting(ctx.guildId, ctx.user.id, u.field, u.value);
        const embed = new EmbedBuilder()
            .setColor(0xF0A500)
            .setAuthor({ name: `${nameOf(ctx, ctx.user)}'s battle settings`, iconURL: ctx.user.displayAvatarURL?.() })
            .setDescription(`**Display = ** \`${s.display}\`\n**Speed = ** \`${s.speed}\`\n**Logs = ** \`${s.logs}\``)
            .setFooter({ text: 'owo battlesetting display=text|compact · speed=instant|short|lengthy · logs=true|false' });
        return ctx.editReply({ embeds: [embed] });
    } catch (e) {
        return fail(ctx, e, 'battle-settings');
    }
}

/** `owo ab` / `owo db` — answer a pending battle challenge from chat. */
export async function answerBattleCmd(ctx, accept) {
    const r = await answerPendingChallenge(ctx, accept);
    if (r.error) return ctx.reply({ content: `❌ ${r.error}`, allowedMentions: NO_PINGS });
    await ctx.message?.react?.(accept ? '⚔️' : '🛡️').catch(() => {});
    return null;
}

// ── Shop: rings + wallpapers ────────────────────────────────────────────────

/** `owo shop` — rings (ids 1-7) and wallpapers (ids 200 + n). */
export async function shopCmd(ctx) {
    await ensureDeferred(ctx);
    try {
        const [wps, owned, wallet] = await Promise.all([
            wallpapers.listWallpapers(),
            wallpapers.ownedWallpaperIds(ctx.guildId, ctx.user.id),
            getCowoncy(ctx.guildId, ctx.user.id),
        ]);
        const ringLines = Object.values(RINGS).map(r => `\`${r.id}\` ${r.emoji} **${r.name}** — ${fmt(r.price)} ${CASH}`);
        const wpLines = wps.map(w => `\`${w.shopId}\` 🖼️ **${w.name}** — ${fmt(w.price)} ${CASH}${owned.has(w.bid) ? ' ✅' : ''}`);
        const embed = new EmbedBuilder()
            .setColor(0xF0A500)
            .setTitle('🛒 OwO Shop')
            .addFields(
                { name: '💍 Rings — marry someone with `owo marry @user <id>`', value: ringLines.join('\n') },
                { name: '🖼️ Wallpapers — for your `owo profile`', value: (wpLines.join('\n') || '*None for sale.*').slice(0, 1024) },
            )
            .setFooter({ text: `Buy: owo buy <id> · Preview: /owo wallpaper shop id:<id> · You have ${fmt(wallet)} cowoncy` });
        return ctx.editReply({ embeds: [embed] });
    } catch (e) {
        return fail(ctx, e, 'shop');
    }
}

/** `owo buy <id>` — a ring or a wallpaper, by shop id. */
export async function buyCmd(ctx, id) {
    await ensureDeferred(ctx);
    const item = resolveShopId(id);
    if (!item) return ctx.editReply('❌ That item does not exist! Please choose one from `owo shop`!');
    const me = nameOf(ctx, ctx.user);
    try {
        if (item.kind === 'ring') {
            const ring = await marriage.buyRing(ctx.guildId, ctx.user.id, item.rid);
            const an = /^[aeiou]/i.test(ring.name) ? 'n' : '';
            return ctx.editReply({ content: `🛒 **| ${me}**, you bought a${an} ${ring.emoji} **${ring.name}** for **${fmt(ring.price)}** ${CASH}!`, allowedMentions: NO_PINGS });
        }
        const wp = await wallpapers.buyWallpaper(ctx.guildId, ctx.user.id, item.bid);
        return ctx.editReply(await wallpaperPreviewPayload(wp,
            `${me}, you have successfully purchased "${wp.name}"!`,
            `Equip it with owo wallpaper ${wp.shopId} (or /owo wallpaper equip id:${wp.shopId})`));
    } catch (e) {
        return fail(ctx, e, 'buy');
    }
}

/** `owo sell <ring id>` — rings sell back for 75%. */
export async function sellRingCmd(ctx, rid) {
    await ensureDeferred(ctx);
    try {
        const r = await marriage.sellRing(ctx.guildId, ctx.user.id, rid);
        const an = /^[aeiou]/i.test(r.ring.name) ? 'n' : '';
        return ctx.editReply({ content: `💰 **| ${nameOf(ctx, ctx.user)}**, you sold a${an} ${r.ring.emoji} **${r.ring.name}** for **${fmt(r.price)}** ${CASH}`, allowedMentions: NO_PINGS });
    } catch (e) {
        return fail(ctx, e, 'ring-sell');
    }
}

export async function ringInventoryCmd(ctx) {
    await ensureDeferred(ctx);
    try {
        const rings = await marriage.listRings(ctx.guildId, ctx.user.id);
        const lines = rings.map(r => `\`${r.ring.id}\` ${r.ring.emoji} **${r.ring.name}** ×${r.count} · sells for ${fmt(ringSellPrice(r.ring.id))} ${CASH}`);
        const embed = new EmbedBuilder()
            .setColor(0xF0A500)
            .setAuthor({ name: `${nameOf(ctx, ctx.user)}'s rings`, iconURL: ctx.user.displayAvatarURL?.() })
            .setDescription(lines.length ? lines.join('\n') : '*No rings — buy one from `owo shop`.*')
            .setFooter({ text: 'Propose: owo marry @user <ring id> · Sell: owo sell <ring id>' });
        return ctx.editReply({ embeds: [embed] });
    } catch (e) {
        return fail(ctx, e, 'rings');
    }
}

// ── Wallpapers ──────────────────────────────────────────────────────────────

async function wallpaperPreviewPayload(wp, title, footer) {
    const embed = new EmbedBuilder()
        .setColor(colorInt(wp.colors[0]))
        .setAuthor({ name: title })
        .setDescription(`🖼️ **${wp.name}** — ${fmt(wp.price)} ${CASH}${wp.description ? `\n*${wp.description}*` : ''}`)
        .setFooter({ text: footer });
    const png = await renderWallpaperPreview(wp);
    if (!png) return { embeds: [embed], components: [] };
    embed.setImage('attachment://wallpaper.png');
    return { embeds: [embed], files: [new AttachmentBuilder(png, { name: 'wallpaper.png' })], components: [] };
}

function toBid(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n > WALLPAPER_SHOP_OFFSET ? n - WALLPAPER_SHOP_OFFSET : n;
}

/** Preview one wallpaper from the shop (id = shop id 2xx or bare bid). */
export async function wallpaperPreviewCmd(ctx, id) {
    await ensureDeferred(ctx);
    const bid = toBid(id);
    const wp = bid ? await wallpapers.getWallpaper(bid).catch(() => null) : null;
    if (!wp || !wp.active) return ctx.editReply('❌ That wallpaper id is not available! See `owo shop`.');
    return ctx.editReply(await wallpaperPreviewPayload(wp, `Wallpaper #${wp.shopId}`, `Buy: owo buy ${wp.shopId}`));
}

/**
 * `owo wallpaper` — list owned wallpapers; `owo wallpaper <id>` — equip one;
 * `owo wallpaper none` — take it off.
 */
export async function wallpaperCmd(ctx, id = null) {
    await ensureDeferred(ctx);
    const me = nameOf(ctx, ctx.user);
    try {
        if (id != null && String(id).length) {
            const off = /^(none|off|0|remove|default)$/i.test(String(id));
            const bid = off ? 0 : toBid(id);
            if (!off && !bid) return ctx.editReply('❌ Usage: `owo wallpaper <id>` — ids are in `owo wallpaper`.');
            const wp = await wallpapers.equipWallpaper(ctx.guildId, ctx.user.id, bid);
            if (!wp) return ctx.editReply('🖼️ Wallpaper removed — your profile is back to the plain card.');
            return ctx.editReply(await wallpaperPreviewPayload(wp, `${me}, your profile wallpaper is now "${wp.name}"!`, 'See it with owo profile'));
        }
        const [owned, equipped] = await Promise.all([
            wallpapers.ownedWallpapers(ctx.guildId, ctx.user.id),
            wallpapers.getEquippedWallpaper(ctx.guildId, ctx.user.id),
        ]);
        const lines = owned.map(w => `\`${w.shopId}\` 🖼️ **${w.name}**${equipped?.bid === w.bid ? ' — *equipped*' : ''}`);
        const embed = new EmbedBuilder()
            .setColor(equipped ? colorInt(equipped.colors[0]) : 0xF0A500)
            .setAuthor({ name: `${me}'s wallpapers`, iconURL: ctx.user.displayAvatarURL?.() })
            .setDescription(lines.length ? lines.join('\n') : "*You don't own any wallpapers yet — buy one from `owo shop`.*")
            .setFooter({ text: 'Equip: owo wallpaper <id> · Remove: owo wallpaper none' });
        return ctx.editReply({ embeds: [embed] });
    } catch (e) {
        return fail(ctx, e, 'wallpaper');
    }
}

// ── Profile ─────────────────────────────────────────────────────────────────

export async function profileCmd(ctx, target = null) {
    await ensureDeferred(ctx);
    try {
        return ctx.editReply(await buildProfileMessage(ctx.guild, ctx.user.id, target || ctx.user));
    } catch (e) {
        return fail(ctx, e, 'profile');
    }
}

// ── Marriage ────────────────────────────────────────────────────────────────

/**
 * The line a daily claim adds when it paid the marriage bonus (result.marriage from
 * core/owo/manager.js claimDaily) — upstream: "💍 | You and X received 345 Cowoncy and a lootbox!".
 * Used by chat `owo daily` and `/owo daily`. Empty string when nothing was paid.
 */
export function marriageDailyLine(m) {
    if (!m) return '';
    const item = m.item === 'lootbox' ? 'a 🎁 **lootbox**' : 'a 📦 **weapon crate**';
    return `\n${m.ring?.emoji ?? '💍'} **|** You and <@${m.partnerId}> received ${CASH} **${fmt(m.amount)} Cowoncy** and ${item}! (day ${m.dailies} together)`;
}

const QUOTES = ['How cute!', 'You look wonderful together!', 'You guys are adorable!', 'The perfect pair!', 'Too cute~!!!'];
const QUOTES2 = ['(´・｀ )♡', '♡´･ᴗ･`♡', '(◕ᴗ◕✿)', '(●⌒ｖ⌒●)', 'OwO', '<3', ';3', 'c;'];
const HEARTS = ['❤', '💛', '💚', '💙', '💜', '❣', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '🎊', '🎉'];
const pick = list => list[Math.floor(Math.random() * list.length)];
const dateText = d => new Date(d).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

/** `owo marry` — status; `owo marry @user <ring id>` — propose, or upgrade the ring if already married to them. */
export async function marryCmd(ctx, target = null, rid = null) {
    await ensureDeferred(ctx);
    const me = nameOf(ctx, ctx.user);
    if (!target && rid == null) return marriageStatus(ctx);
    if (!target || rid == null) {
        return ctx.editReply("❌ Please include the person you're marrying and the ring id: `owo marry @user <ring id>`.");
    }
    if (target.id === ctx.client?.user?.id) return ctx.editReply("❌ Sorry love! I'm already taken c;");
    if (target.bot) return ctx.editReply("❌ You silly hooman! You can't marry a bot!");
    try {
        const r = await marriage.propose(ctx.guildId, ctx.user.id, target.id, rid, ctx.channelId ?? ctx.channel?.id);
        if (r.upgrade) {
            const an = /^[aeiou]/i.test(r.newRing.name) ? 'n' : '';
            const ok = await askConfirm(ctx, {
                content: '',
                embeds: [new EmbedBuilder().setColor(0xF0A500).setDescription(
                    `**${me}**, are you sure you want to change your ${r.currentRing.emoji} **${r.currentRing.name}** to a${an} **${r.newRing.name}**?\n*You will not get your ring back!*`)],
            });
            if (!ok) {
                return ctx.editReply({ content: ok === null ? '⌛ Ring change timed out.' : `${r.currentRing.emoji} You decided not to upgrade.`, embeds: [], components: [] });
            }
            const up = await marriage.upgradeRing(ctx.guildId, ctx.user.id, r.newRing.id);
            return ctx.editReply({ content: `${up.ring.emoji} You changed your ring to a${an} **${up.ring.name}**!`, embeds: [], components: [], allowedMentions: NO_PINGS });
        }
        const embed = new EmbedBuilder()
            .setColor(0xF0A500)
            .setAuthor({ name: `${me} has proposed to ${nameOf(ctx, target)} with a ${r.ring.name}!`, iconURL: ctx.user.displayAvatarURL?.() })
            .addFields({
                name: 'Once you accept, you both get an extra lootbox or weapon crate (and cowoncy) on days you both claim your daily!',
                value: '`owo am` to accept  |  `owo dm` to decline\n(or `/owo marry accept` / `/owo marry decline`)\n'
                    + `Divorce anytime with \`owo divorce\`, or upgrade the ring with \`owo marry @${target.username} <ring id>\`.`,
            })
            .setTimestamp(new Date());
        return ctx.editReply({ content: `<@${target.id}> ${r.ring.emoji}`, embeds: [embed], allowedMentions: { users: [target.id] } });
    } catch (e) {
        return fail(ctx, e, 'marry');
    }
}

async function marriageStatus(ctx) {
    const me = nameOf(ctx, ctx.user);
    try {
        const m = await marriage.getMarriage(ctx.guildId, ctx.user.id);
        if (!m) {
            const p = await marriage.getProposals(ctx.guildId, ctx.user.id);
            const lines = [
                ...p.incoming.map(x => `💌 <@${x.from}> proposed to you with a **${x.ring?.name}** — \`owo am\` to accept, \`owo dm\` to decline.`),
                ...p.outgoing.map(x => `💍 You proposed to <@${x.to}> with a **${x.ring?.name}** — waiting for an answer (\`owo dm\` withdraws it).`),
            ];
            return ctx.editReply({
                content: lines.length
                    ? lines.join('\n')
                    : "❌ You are not married! Buy a ring from `owo shop` and include its id: `owo marry @user <ring id>`.",
                allowedMentions: NO_PINGS,
            });
        }
        const partner = await ctx.client?.users?.fetch(m.partnerId).catch(() => null);
        const embed = new EmbedBuilder()
            .setColor(0xF0A500)
            .setAuthor({ name: `${me}, you are happily married to ${partner ? nameOf(ctx, partner) : 'someone'}!`, iconURL: ctx.user.displayAvatarURL?.() })
            .setDescription(`${m.ring.emoji} **${m.ring.name}**\nMarried since **${dateText(m.marriedAt)}** (**${m.days} days**)\n`
                + `You have claimed **${fmt(m.dailies)} dailies** together!\n${pick(QUOTES)} ${pick(QUOTES2)}`);
        return ctx.editReply({ embeds: [embed], allowedMentions: NO_PINGS });
    } catch (e) {
        return fail(ctx, e, 'marry-status');
    }
}

/** `owo am` */
export async function acceptMarriageCmd(ctx) {
    await ensureDeferred(ctx);
    try {
        const r = await marriage.acceptProposal(ctx.guildId, ctx.user.id);
        if (r.failed) return ctx.editReply('❌ One of you got married in the meantime, so the proposal fell through. The ring went back to the proposer.');
        const sender = await ctx.client?.users?.fetch(r.senderId).catch(() => null);
        const hearts = [pick(HEARTS), pick(HEARTS), pick(HEARTS)].join(' ');
        return ctx.editReply({
            content: `${r.ring.emoji} **| ${nameOf(ctx, ctx.user)}** and **${sender ? nameOf(ctx, sender) : 'your love'}** are now married! Congratulations!! ${hearts}`,
            allowedMentions: NO_PINGS,
        });
    } catch (e) {
        return fail(ctx, e, 'marry-accept');
    }
}

/** `owo dm` — decline a proposal, or withdraw your own. */
export async function declineMarriageCmd(ctx) {
    await ensureDeferred(ctx);
    try {
        const r = await marriage.declineProposal(ctx.guildId, ctx.user.id);
        const other = await ctx.client?.users?.fetch(r.otherId).catch(() => null);
        const otherName = other ? nameOf(ctx, other) : 'them';
        return ctx.editReply({
            content: r.outgoing
                ? `💔 **| ${nameOf(ctx, ctx.user)}**, you withdrew your proposal to ${otherName}. Your ${r.ring?.name ?? 'ring'} is back in your pocket.`
                : `💔 **| ${nameOf(ctx, ctx.user)}**, you have declined a marriage request from ${otherName}!`,
            allowedMentions: NO_PINGS,
        });
    } catch (e) {
        return fail(ctx, e, 'marry-decline');
    }
}

/** `owo divorce` — with a confirmation. */
export async function divorceCmd(ctx) {
    await ensureDeferred(ctx);
    const me = nameOf(ctx, ctx.user);
    try {
        const m = await marriage.getMarriage(ctx.guildId, ctx.user.id);
        if (!m) return ctx.editReply("❌ You can't divorce if you aren't married, silly butt!");
        const partner = await ctx.client?.users?.fetch(m.partnerId).catch(() => null);
        const embed = new EmbedBuilder()
            .setColor(0xF0A500)
            .setAuthor({ name: `${me}, are you sure you want to divorce${partner ? ` ${nameOf(ctx, partner)}` : ''}?`, iconURL: ctx.user.displayAvatarURL?.() })
            .setDescription(`You married on **${dateText(m.marriedAt)}** and have been married for **${m.days}** days and claimed **${m.dailies}** dailies together... `
                + 'Once you divorce, the ring will break and disappear.');
        const ok = await askConfirm(ctx, { content: '', embeds: [embed] }, { yes: 'Divorce', no: 'Stay married' });
        if (!ok) {
            embed.setColor(0x616363).setDescription(`${embed.data.description}\n\n${ok === null ? '⌛ No answer — still married.' : '💝 You have decided to stay married!'}`);
            return ctx.editReply({ embeds: [embed], components: [] });
        }
        await marriage.divorce(ctx.guildId, ctx.user.id);
        embed.setColor(0x616363).setDescription(`${embed.data.description}\n\n💔 You have decided to divorce.`);
        return ctx.editReply({ embeds: [embed], components: [] });
    } catch (e) {
        return fail(ctx, e, 'divorce');
    }
}
