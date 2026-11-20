/*
 * Critters: every member-facing action of the /owo game.
 *
 * One table (ACTIONS) shared by all three ways in, so the wording and the rules cannot drift between them:
 *   - the text-slash commands  commands/fun/critters*.js  (`/owo hunt`, `!owo hunt`, `/owo marry accept`)
 *   - the `!owo <word>` router  handlers/critters-prefix.js
 *   - the natural prefix        core/critters-natural-prefix.js  (`owoh`, `owo zoo`)
 *
 * runAction() applies the gates in order (inside a server, admin-only actions, module on, the action's feature
 * switch, game channels, blocked roles), counts the `command` quest only for actions that got through the gates,
 * and turns service refusals (CritterError) into a reply. Game rules live in core/critters (docs/critters-api.md);
 * this file only decides what to call and how to say it. All wording here is original to CertiFried.
 */
import {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, AttachmentBuilder,
} from 'discord.js';
import * as critters from '../core/critters/index.js';
import { owoifyText } from '../core/text-owoify.js';
import { awardAchievement } from '../core/achievement-hooks.js';
import logger from '../utils/logger.js';

const { data } = critters;

/*
 * Tiers whose catches go to the server's audit log as `owoRareCatch.<tier>` (when "log rare catches" is on).
 * tests/log-actions.test.js reads this Set; tests/critters-surfaces.test.js checks it equals data.AUDITABLE_TIERS.
 */
const AUDITABLE_RANKS = new Set(['epic', 'mythical', 'legendary', 'fabled']);
export const RARE_LOG_TIERS = AUDITABLE_RANKS;

const MOSS = 0x5f7a4f;
const WIN = 0x3f9d5a;
const LOSS = 0xc0504d;
const DRAW = 0x8a8f98;
const FAILED = 'Something went wrong on our side, so nothing changed. Try again in a moment.';

const fmt = (n) => (Number(n) || 0).toLocaleString('en-US');
const acorns = (n) => critters.formatAcorns(n);
const ts = (d, style = 'R') => `<t:${Math.floor(new Date(d).getTime() / 1000)}:${style}>`;
const after = (ms, style = 'R') => ts(Date.now() + Math.max(0, Number(ms) || 0), style);
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${Number(n) === 1 ? one : many}`;
const tierOf = (t) => (t && typeof t === 'object' ? t : data.tierByKey(t));
const critter = (s) => (s ? `${s.emoji} ${s.name}` : 'a mystery critter');
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/* ----------------------------------------------------------------------------------------------- plumbing */

export function isAdmin(ix) {
    try {
        const p = ix.memberPermissions ?? ix.member?.permissions;
        return !!p?.has?.(PermissionFlagsBits.ManageGuild);
    } catch {
        return false;
    }
}

export function roleIdsOf(member) {
    if (!member) return [];
    if (member.roles?.cache) return [...member.roles.cache.keys()];
    if (Array.isArray(member.roles)) return member.roles.map(String);
    return [];
}

/** Display name of a user in this server (falls back to the username). */
function nameOf(ix, user) {
    if (!user) return 'someone';
    const m = ix.guild?.members?.cache?.get?.(user.id);
    return m?.displayName || user.globalName || user.username || 'someone';
}

/**
 * Reply, edit a deferred reply, or follow up, whichever fits. Nobody is pinged unless the payload says so.
 * fetch: true returns the posted Message (needed for collectors and stored message ids).
 */
export async function say(ix, payload, { ephemeral = false, fetch = false } = {}) {
    const p = typeof payload === 'string' ? { content: payload } : { ...payload };
    if (!p.allowedMentions) p.allowedMentions = { parse: [] };
    if (ephemeral) p.flags = MessageFlags.Ephemeral;
    let msg;
    if (ix.deferred && !ix.replied) {
        const { flags, ...rest } = p;
        msg = await ix.editReply(rest);
    } else if (ix.replied) {
        msg = await ix.followUp(p);
    } else {
        msg = await ix.reply(p);
    }
    if (fetch && !(msg && msg.author && msg.channelId)) {
        msg = (await ix.fetchReply?.().catch(() => null)) || msg;
    }
    return msg;
}

/** A user object for a mention, id or User; null when it cannot be found. */
export async function resolveUser(ix, target) {
    if (!target) return null;
    if (typeof target === 'object' && target.id) return target;
    const m = String(target).match(/^<@!?(\d{15,25})>$/) || String(target).match(/^(\d{15,25})$/);
    if (!m) return null;
    return ix.client?.users?.cache?.get(m[1]) || await ix.client?.users?.fetch?.(m[1]).catch(() => null) || null;
}

async function requireUser(ix, target, what = 'Mention the member you mean.') {
    const user = await resolveUser(ix, target);
    if (!user) throw new critters.CritterError('NO_TARGET', what);
    return user;
}

const toInt = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
};

/* ----------------------------------------------------------------------------------------------- the gate runner */

/**
 * Run one action for an interaction or a MessageContextAdapter. Returns 'ran', 'refused' (a gate said no and the
 * member was told why) or 'failed'. Never throws for member mistakes.
 */
export async function runAction(ix, name, args = {}, { natural = false } = {}) {
    const def = ACTIONS[name];
    if (!def) throw new Error(`unknown critters action: ${name}`);
    if (!ix.guildId && def.gate !== false) {
        await say(ix, 'The critters game lives inside servers. Try this in one.', { ephemeral: true });
        return 'refused';
    }
    const admin = isAdmin(ix);
    if (def.admin && !admin) {
        await say(ix, 'That one needs the **Manage Server** permission.', { ephemeral: true });
        return 'refused';
    }
    const key = typeof def.key === 'function' ? def.key(args) : def.key;
    if (def.gate !== false) {
        const g = await critters.gate(ix.guildId, {
            featureKey: key ?? null, channelId: ix.channelId, roleIds: roleIdsOf(ix.member), skipPlaceGates: !!def.admin,
        });
        if (!g.ok) {
            await say(ix, critters.gateMessage(g, { isAdmin: admin }), { ephemeral: true });
            return 'refused';
        }
        // The `command` quest counts game commands that got through their gates (never toggles or admin grants).
        if (key) {
            try { await critters.bumpQuest(ix.guildId, ix.user.id, 'command', 1); } catch (e) { logger.debug('[critters] command quest bump failed', { error: e.message }); }
        }
    }
    try {
        await def.run(ix, args, { admin, natural });
        return 'ran';
    } catch (err) {
        if (critters.isCritterError(err)) {
            await say(ix, err.message, { ephemeral: true }).catch(() => {});
            return 'ran';
        }
        logger.error('[critters] action failed', { action: name, guildId: ix.guildId, error: err.message, stack: err.stack });
        await say(ix, FAILED, { ephemeral: true }).catch(() => {});
        return 'failed';
    }
}

/* ----------------------------------------------------------------------------------------------- hunting */

function gemLine(res) {
    const parts = [];
    for (const g of res.gems || []) {
        const gem = data.gemById(g.gemId);
        if (gem) parts.push(`${gem.icon} ${gem.name} \`[${g.after}/${gem.length}]\``);
    }
    return parts;
}

/** The hunt reply, shared by every hunt path. */
export function huntText(ix, res) {
    const who = `**${nameOf(ix, ix.user)}**`;
    const lines = [];
    const gems = gemLine(res);
    if (gems.length) {
        lines.push(`${who} sets out with ${gems.join(', ')}`);
        const icons = res.catches.flatMap(c => Array(Math.min(c.count, 60)).fill(c.species.emoji));
        const shown = icons.slice(0, 120).join(' ');
        lines.push(`and comes home with ${plural(res.total, 'critter')}: ${shown}${icons.length > 120 ? ' …' : ''}`);
    } else {
        const c = res.catches[0];
        const t = tierOf(c.species.tier);
        lines.push(`${who} pokes around the undergrowth and spots a ${t.name.toLowerCase()} critter: ${c.species.emoji} **${c.species.name}**`);
    }
    const extra = [];
    extra.push(`+${acorns(res.currency)}`);
    if (res.rarest?.firstCatch) extra.push(`first ${res.rarest.species.name} you have ever caught`);
    lines.push(extra.join(' · '));
    if (res.teamXp?.members?.length) {
        const ups = res.teamXp.members.filter(m => m.leveledUp).map(m => `${m.species?.emoji || ''} level ${m.level}`);
        lines.push(`Your team picks up ${fmt(res.teamXp.xp)} XP each${ups.length ? ` (${ups.join(', ')})` : ''}.`);
    }
    if (res.lootbox?.dropped) {
        lines.push(`A lootbox was hiding under a log. \`[${res.lootbox.count}/${res.lootbox.max}]\` today, the count resets ${after(res.lootbox.resetsInMs)}. Open it with \`owo lootbox\`.`);
    }
    return lines.join('\n');
}

async function logRareCatch(ix, res) {
    try {
        const tier = res?.rarest?.tier?.key;
        if (!res?.announceRare || !AUDITABLE_RANKS.has(tier) || !ix.guild) return;
        const embed = new EmbedBuilder()
            .setTitle(`Rare catch: ${res.rarest.tier.name}`)
            .setColor(res.rarest.tier.color ?? MOSS)
            .addFields(
                { name: 'Member', value: `<@${ix.user.id}>`, inline: true },
                { name: 'Channel', value: ix.channelId ? `<#${ix.channelId}>` : 'unknown', inline: true },
                { name: 'Critter', value: critter(res.rarest.species), inline: true },
                { name: 'First of its kind', value: res.rarest.firstCatch ? 'Yes' : 'No', inline: true },
                { name: 'Hunt reward', value: acorns(res.currency), inline: true },
                { name: 'Odds for this critter', value: `${res.rollChancePct}%`, inline: true },
            )
            .setTimestamp();
        const { sendLogEmbed } = await import('../core/log-manager.js');
        await sendLogEmbed(ix.guild, 'owoRareCatch', embed, `owoRareCatch.${tier}`);
    } catch (err) {
        logger.debug('[critters] rare catch log failed', { error: err.message });
    }
}

async function fetchMessage(ix, channelId, messageId) {
    if (!channelId || !messageId) return null;
    const ch = ix.guild?.channels?.cache?.get(String(channelId)) || await ix.guild?.channels?.fetch?.(String(channelId)).catch(() => null);
    return ch?.messages ? ch.messages.fetch(String(messageId)).catch(() => null) : null;
}

/** A hunt can wake a guild boss: post its announcement where the hunt happened and remember the message. */
async function postBoss(ix, boss) {
    if (!boss) return;
    try {
        if (boss.fledPrevious) {
            const old = await fetchMessage(ix, boss.fledPrevious.channelId, boss.fledPrevious.messageId);
            if (old?.editable) await old.edit({ content: 'This boss slipped away while nobody was looking.', components: [] }).catch(() => {});
        }
        const channel = ix.channel;
        if (!channel?.send) return;
        const msg = await channel.send(critters.bossMessage(boss));
        await critters.setBossMessage(ix.guildId, channel.id, msg.id);
    } catch (err) {
        logger.warn('[critters] boss announcement failed', { guildId: ix.guildId, error: err.message });
    }
}

async function doHunt(ix) {
    const res = await critters.hunt(ix.guildId, ix.user.id, { channelId: ix.channelId });
    await say(ix, huntText(ix, res));
    await logRareCatch(ix, res);
    await postBoss(ix, res.boss);
}

async function doZoo(ix, a) {
    const user = (await resolveUser(ix, a.target)) || ix.user;
    const z = await critters.getZoo(ix.guildId, user.id);
    const embed = new EmbedBuilder().setTitle(`${nameOf(ix, user)}'s zoo`).setColor(MOSS);
    if (!z.groups.length) {
        embed.setDescription(user.id === ix.user.id ? 'Empty for now. Go and find something with `owo hunt`.' : 'Nothing caught yet.');
    } else {
        for (const g of z.groups.slice(0, 25)) {
            const t = tierOf(g.tier);
            const value = g.species.map(x => `${x.species.emoji} ${fmt(x.count)}`).join('  ');
            embed.addFields({ name: `${t.icon} ${t.name}`, value: value.slice(0, 1024) });
        }
    }
    embed.setFooter({ text: `${z.uniqueAnimals}/${z.catalogSize} kinds found · ${fmt(z.totalCatches)} caught in all · ${z.completionPct}% of the catalog` });
    await say(ix, { embeds: [embed] });
}

const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
const place = (i) => MEDALS[i] || `\`${String(i + 1).padStart(2)}\``;

async function doLeaderboard(ix) {
    const rows = await critters.huntLeaderboard(ix.guildId, 10);
    const embed = new EmbedBuilder().setTitle('Top hunters on this server').setColor(MOSS)
        .setDescription(rows.length
            ? rows.map((r, i) => `${place(i)} <@${r.userId}> · ${plural(r.total, 'catch', 'catches')} · ${plural(r.unique, 'kind')}`).join('\n')
            : 'Nobody has caught anything yet.');
    await say(ix, { embeds: [embed] });
}

const BOARD_TITLES = { cookies: 'Most cookies received', luck: 'Luckiest members', curse: 'Most cursed members' };
async function doSocialTop(ix, a) {
    const type = { cookie: 'cookies', cookies: 'cookies', rep: 'cookies', luck: 'luck', pray: 'luck', curse: 'curse', curses: 'curse' }[String(a.kind || '').toLowerCase()];
    if (!type) throw new critters.CritterError('BAD_BOARD', 'Pick a board: cookies, luck or curse.');
    const b = await critters.socialBoard(ix.guildId, type, { userId: ix.user.id, limit: 10 });
    const lines = b.rows.map((r, i) => `${place(i)} <@${r.userId}> · ${fmt(r.value)}`);
    const embed = new EmbedBuilder().setTitle(BOARD_TITLES[type]).setColor(MOSS)
        .setDescription(lines.length ? lines.join('\n') : 'Nobody is on this board yet.');
    if (b.you) embed.setFooter({ text: `You: ${fmt(b.you.value)} (place ${fmt(b.you.place)})` });
    await say(ix, { embeds: [embed] });
}

async function doCatalog(ix) {
    const embed = new EmbedBuilder().setTitle('Every critter there is to find').setColor(MOSS)
        .setDescription(`${data.CATALOG_SIZE} kinds in ${data.TIERS.length} tiers. The percentage is the chance a catch lands in that tier.`);
    for (const row of critters.getCatalog()) {
        if (!row.species.length) continue;
        const t = tierOf(row.tier);
        embed.addFields({ name: `${t.icon} ${t.name} · ${row.chancePct}%`, value: row.species.map(s => `${s.emoji} ${s.name}`).join(', ').slice(0, 1024) });
    }
    await say(ix, { embeds: [embed] }, { ephemeral: true });
}

async function doSell(ix, a) {
    const res = await critters.sellDuplicates(ix.guildId, ix.user.id, a.rank);
    if (!res.sold) return say(ix, `You have no spare ${res.tier.name.toLowerCase()} critters to sell. You always keep one of each kind.`);
    return say(ix, `Sold ${plural(res.sold, `spare ${res.tier.name.toLowerCase()} critter`)} at ${acorns(res.price)} each: +${acorns(res.currency)}. You now have ${acorns(res.balance)}.`);
}

async function doSacrifice(ix, a) {
    const res = await critters.sacrificeDuplicates(ix.guildId, ix.user.id, a.rank);
    if (!res.sacrificed) return say(ix, `You have no spare ${res.tier.name.toLowerCase()} critters to offer. You always keep one of each kind.`);
    return say(ix, `${plural(res.sacrificed, `spare ${res.tier.name.toLowerCase()} critter`)} turned into ${fmt(res.essence)} essence (${fmt(res.essencePer)} each). You hold ${fmt(res.essenceTotal)} essence; feed it to a critter with \`owo feed <critter> <amount>\`.`);
}

async function doFeed(ix, a) {
    if (!a.animal) throw new critters.CritterError('BAD_INPUT', 'Say which critter to feed and how much essence, for example `owo feed fox 50`.');
    const res = await critters.feedEssence(ix.guildId, ix.user.id, a.animal, a.amount);
    const up = res.level > res.levelBefore ? ` and grows from level ${res.levelBefore} to ${res.level}` : '';
    return say(ix, `${critter(res.species)} gobbles it up: +${fmt(res.xpGained)} XP${up}. Essence left: ${fmt(res.essenceLeft)}.`);
}

async function doStats(ix, a) {
    const user = (await resolveUser(ix, a.target)) || ix.user;
    const s = await critters.getStats(ix.guildId, user.id);
    const perTier = s.perTier.filter(x => x.count > 0).map(x => { const t = tierOf(x.tier); return `${t.icon} ${t.name}: ${fmt(x.count)}`; });
    const embed = new EmbedBuilder().setTitle(`${nameOf(ix, user)}'s hunting numbers`).setColor(MOSS)
        .setDescription(perTier.length ? perTier.join('\n') : 'No catches yet.')
        .addFields(
            { name: 'Caught in all', value: fmt(s.totalCatches), inline: true },
            { name: 'Kinds found', value: `${s.uniqueAnimals}/${s.catalogSize}`, inline: true },
            { name: 'Acorns', value: acorns(s.wallet.balance), inline: true },
            { name: 'Rarest owned', value: s.rarest ? critter(s.rarest) : 'None yet', inline: true },
        );
    await say(ix, { embeds: [embed] });
}

/* ----------------------------------------------------------------------------------------------- wallet */

async function doDaily(ix) {
    const res = await critters.claimDaily(ix.guildId, ix.user.id);
    const lines = [];
    if (!res.claimed) {
        lines.push(`Your daily acorns are not ready yet. Come back ${after(res.cooldown?.msLeft)}.`);
    } else {
        const bonus = res.payout.bonus ? ` (${acorns(res.payout.base)} plus a ${acorns(res.payout.bonus)} streak bonus)` : '';
        lines.push(`You collected ${acorns(res.payout.total)}${bonus}. Streak: ${plural(res.streak, 'day')}. Balance: ${acorns(res.balance)}.`);
        lines.push('-# This is the critters daily. The server economy has its own.');
    }
    if (res.coupleBonus) {
        const item = res.coupleBonus.item === 'crate' ? 'a weapon crate' : 'a lootbox';
        lines.push(`Couple bonus with <@${res.coupleBonus.partnerId}>: you both get ${acorns(res.coupleBonus.amount)} and ${item}. (${plural(res.coupleBonus.dailies, 'shared day')} so far)`);
    }
    await say(ix, lines.join('\n'));
}

async function doBalance(ix) {
    const w = await critters.getWallet(ix.guildId, ix.user.id);
    await say(ix, `You have ${acorns(w.balance)}. Essence: ${fmt(w.essence)} · Weapon shards: ${fmt(w.shards)}.`);
}

async function doGive(ix, a) {
    const to = await requireUser(ix, a.target, 'Mention who should get the acorns, for example `owo give @Sam 500`.');
    if (to.bot) throw new critters.CritterError('BOT', 'Bots have nowhere to keep acorns.');
    const amount = toInt(a.amount);
    if (!amount || amount < 1) throw new critters.CritterError('BAD_AMOUNT', 'Give at least 1 acorn.');
    const res = await critters.give(ix.guildId, ix.user.id, to.id, amount, { receiverName: nameOf(ix, to) });
    await say(ix, `You handed ${acorns(res.amount)} to <@${to.id}>. You have ${acorns(res.fromBalance)} left.`);
}

async function doGiveLimits(ix) {
    const l = await critters.getGiveLimits(ix.guildId, ix.user.id);
    await say(ix, [
        `**Today's transfer limits** (server level ${l.level})`,
        `Sent: ${acorns(l.sent)} of ${acorns(l.sendCap)}`,
        `Received: ${acorns(l.received)} of ${acorns(l.receiveCap)}`,
        `Both reset ${after(l.resetsInMs)}.`,
    ].join('\n'));
}

async function doTransactions(ix, a, { admin }) {
    const target = await resolveUser(ix, a.target);
    const server = !!a.server;
    if ((server || (target && target.id !== ix.user.id)) && !admin) {
        throw new critters.CritterError('NOT_ALLOWED', 'Only members with **Manage Server** can look at someone else\'s transfers.');
    }
    const rows = await critters.listTransactions(ix.guildId, { userId: server ? null : (target || ix.user).id, server, limit: 15 });
    const who = (id, floor) => (floor ? 'the floor' : `<@${id}>`);
    const title = server ? 'Latest transfers on this server' : `Latest transfers for ${nameOf(ix, target || ix.user)}`;
    const embed = new EmbedBuilder().setTitle(title).setColor(MOSS).setDescription(rows.length
        ? rows.map(r => `${ts(r.at)} ${who(r.sender, r.senderIsFloor)} → ${who(r.receiver, r.receiverIsFloor)} · ${acorns(r.amount)}${r.kind && r.kind !== 'give' ? ` (${r.kind})` : ''}`).join('\n')
        : 'No transfers yet.');
    await say(ix, { embeds: [embed] }, { ephemeral: true });
}

async function doDrop(ix, a) {
    const res = await critters.dropToFloor(ix.guildId, ix.user.id, ix.channelId, toInt(a.amount));
    await say(ix, `You let ${acorns(res.amount)} fall to the floor of this channel. Whoever guesses the right amount with \`owo pickup <amount>\` keeps it.`);
}

async function doPickup(ix, a) {
    const res = await critters.pickupFromFloor(ix.guildId, ix.user.id, ix.channelId, toInt(a.amount));
    await say(ix, `You scoop ${acorns(res.amount)} off the floor. Balance: ${acorns(res.balance)}.`);
}

/* ----------------------------------------------------------------------------------------------- gear */

function weaponLine(w) {
    const bits = [`\`${w.uwid}\``, `${w.type.emoji} **${w.type.name}**`, w.rank.name, `quality ${w.quality}`, w.wear.name];
    if (w.tracked) bits.push(`${fmt(w.kills)} takedowns`);
    if (w.favorite) bits.push('★');
    if (w.petPid) bits.push('equipped');
    return bits.join(' · ');
}

function weaponEmbed(w, title = null) {
    const embed = new EmbedBuilder().setTitle(title || `${w.type.emoji} ${w.type.name} #${w.uwid}`).setColor(MOSS)
        .setDescription(w.type.description || null)
        .addFields(
            { name: 'Rank', value: w.rank.name, inline: true },
            { name: 'Quality', value: `${w.quality} (range ${w.type.quality[0]}-${w.type.quality[1]})`, inline: true },
            { name: 'Wear', value: w.wear.name, inline: true },
        );
    if (w.perks?.length) embed.addFields({ name: 'Perks', value: w.perks.map(p => `**${p.name}** (${p.quality}): ${p.description}`).join('\n').slice(0, 1024) });
    if (w.tracked) embed.addFields({ name: 'Takedown tracker', value: plural(w.kills, 'takedown'), inline: true });
    if (w.favorite) embed.addFields({ name: 'Favourite', value: 'Protected from dismantling', inline: true });
    return embed;
}

async function doWeapon(ix, a) {
    const id = toInt(a.id);
    if (id) return say(ix, { embeds: [weaponEmbed(await critters.getWeapon(ix.guildId, ix.user.id, id))] });
    const res = await critters.listWeapons(ix.guildId, ix.user.id, { limit: 30 });
    const embed = new EmbedBuilder().setTitle(`${nameOf(ix, ix.user)}'s armory`).setColor(MOSS)
        .setDescription(res.weapons.length ? res.weapons.map(weaponLine).join('\n').slice(0, 4000) : 'No weapons yet. Battles drop weapon crates; open one with `owo crate`.')
        .setFooter({ text: `${fmt(res.total)} weapons${res.total > res.weapons.length ? `, newest ${res.weapons.length} shown` : ''} · details: owo weapon <id>` });
    await say(ix, { embeds: [embed] });
}

async function doCrate(ix) {
    const res = await critters.openCrate(ix.guildId, ix.user.id);
    await say(ix, { content: `You pry the crate open. ${plural(res.cratesLeft, 'crate')} left.`, embeds: [weaponEmbed(res.weapon, `New: ${res.weapon.type.emoji} ${res.weapon.type.name} #${res.weapon.uwid}`)] });
}

async function doShards(ix) {
    await say(ix, `You have ${plural(await critters.getShards(ix.guildId, ix.user.id), 'weapon shard')}.`);
}

async function doDismantle(ix, a) {
    const res = await critters.dismantleWeapon(ix.guildId, ix.user.id, toInt(a.uwid));
    await say(ix, `${res.weapon.type.emoji} ${res.weapon.type.name} #${res.weapon.uwid} is now ${plural(res.shards, 'shard')}. You have ${fmt(res.shardsTotal)}.`);
}

async function doForge(ix, a) {
    const res = await critters.forgeWeapon(ix.guildId, ix.user.id, a.rank);
    await say(ix, { content: `The forge takes ${plural(res.cost, 'shard')} (${fmt(res.shardsLeft)} left) and hands you:`, embeds: [weaponEmbed(res.weapon)] });
}

async function doFavorite(ix, a) {
    const res = await critters.setFavorite(ix.guildId, ix.user.id, toInt(a.uwid), a.favorite !== false);
    await say(ix, res.favorite ? `Weapon #${res.uwid} is a favourite now and cannot be dismantled.` : `Weapon #${res.uwid} is no longer a favourite.`);
}

async function doForgePrices(ix) {
    const rows = critters.forgePrices();
    await say(ix, ['**Forge prices** (shards to forge · shards from dismantling)', ...rows.map(r => `${r.name}: ${fmt(r.cost)} · ${fmt(r.dismantle)}`)].join('\n'));
}

async function doLootbox(ix, a) {
    const res = await critters.openLootboxes(ix.guildId, ix.user.id, a.count ?? 1);
    const msg = await say(ix, `You shake ${plural(res.opened, 'lootbox', 'lootboxes')} and lift the lid${res.opened === 1 ? '' : 's'}...`, { fetch: true });
    await sleep(3000);
    const found = res.gems.map(g => `${g.gem.icon} ${g.gem.name}${g.count > 1 ? ` ×${g.count}` : ''} \`${g.gem.id}\``).join('\n');
    const text = `Inside: \n${found}\n${plural(res.left, 'lootbox', 'lootboxes')} left. Switch a gem on with \`owo use <id>\`.`;
    if (msg?.edit) await msg.edit({ content: text, allowedMentions: { parse: [] } }).catch(() => say(ix, text));
    else await say(ix, text);
}

async function doGems(ix) {
    const g = await critters.getGems(ix.guildId, ix.user.id);
    const embed = new EmbedBuilder().setTitle(`${nameOf(ix, ix.user)}'s gems`).setColor(MOSS)
        .addFields(
            { name: 'Working now', value: g.active.length ? g.active.map(x => `${x.gem.icon} ${x.gem.name}: ${x.usesLeft}/${x.length} uses left`).join('\n') : 'None' },
            { name: 'In your pouch', value: g.inventory.length ? g.inventory.map(x => `\`${x.gem.id}\` ${x.gem.icon} ${x.gem.name} ×${x.count}`).join('\n').slice(0, 1024) : 'Empty. Lootboxes are full of gems.' },
        )
        .setFooter({ text: 'Switch gems on with owo use <id> (up to one of each kind)' });
    await say(ix, { embeds: [embed] });
}

async function doUse(ix, a) {
    const res = await critters.useGems(ix.guildId, ix.user.id, a.ids ?? a.text ?? '');
    await say(ix, `Switched on: ${res.activated.map(x => `${x.gem.icon} ${x.gem.name} (${x.usesLeft} uses)`).join(', ')}.`);
}

async function doGrantCrate(ix, a) {
    const to = await requireUser(ix, a.target, 'Mention who should get the crates.');
    if (to.bot) throw new critters.CritterError('BOT', 'Bots cannot open crates.');
    const count = Math.max(1, Math.min(100, toInt(a.count) || 1));
    const res = await critters.grantCrates(ix.guildId, to.id, count);
    await say(ix, `Gave <@${to.id}> ${plural(res.delta, 'weapon crate')}. They now have ${fmt(res.total)}.`, { ephemeral: true });
}

/* ----------------------------------------------------------------------------------------------- teams */

function teamEmbed(ix, team) {
    const embed = new EmbedBuilder().setTitle(team.name).setColor(MOSS);
    if (!team.slots.length) embed.setDescription('This team is empty. Add a critter with `owo team add <critter>`.');
    for (const s of team.slots) {
        const st = s.species.stats;
        const lines = [
            `${tierOf(s.species.tier).name} · level ${s.level}${s.nickname ? ` · "${s.nickname}"` : ''}`,
            `HP ${st.hp} · ATK ${st.atk} · PR ${st.pr} · WP ${st.wp} · MAG ${st.mag} · MR ${st.mr}`,
            `In battle: ${fmt(s.combat.maxHp)} HP, ${fmt(s.combat.atk)} attack, ${fmt(s.combat.def)} defence`,
            s.weapon ? `Holding ${s.weapon.type.emoji} ${s.weapon.type.name} #${s.weapon.uwid} (${s.weapon.rank.name}${s.weapon.perks?.length ? `; ${s.weapon.perks.map(p => p.name).join(', ')}` : ''})` : 'No weapon',
        ];
        embed.addFields({ name: `${s.pos}. ${critter(s.species)}`, value: lines.join('\n').slice(0, 1024) });
    }
    embed.setFooter({ text: `Team #${team.teamId}${team.active ? ' (active)' : ''} · ${team.wins}W ${team.losses}L · streak ${team.streak} · best ${team.bestStreak}` });
    return embed;
}

async function doTeamView(ix, a) {
    const team = await critters.getTeam(ix.guildId, ix.user.id, toInt(a.pgid));
    const teams = await critters.listTeams(ix.guildId, ix.user.id);
    const others = teams.filter(t => t.teamId !== team.teamId).map(t => `#${t.teamId} ${t.name}`);
    await say(ix, { content: others.length ? `Your other teams: ${others.join(', ')}` : undefined, embeds: [teamEmbed(ix, team)] });
}

async function doTeamCreate(ix, a) {
    const res = await critters.createTeam(ix.guildId, ix.user.id, a.name || '');
    await say(ix, `Team **${res.name}** (#${res.teamId}) is ready${res.active ? ' and active' : ''}. ${res.active ? '' : `Switch to it with \`owo team switch ${res.teamId}\`.`}`.trim());
}

async function doTeamAdd(ix, a) {
    if (!a.animal) throw new critters.CritterError('BAD_INPUT', 'Name the critter to add, for example `owo team add fox`.');
    const res = await critters.addToTeam(ix.guildId, ix.user.id, a.animal);
    await say(ix, `${critter(res.species)} joins your team in slot ${res.pos}.${res.createdTeam ? ' (You had no team, so a new one was made.)' : ''}`);
}

async function doTeamRemove(ix, a) {
    const res = await critters.removeFromTeam(ix.guildId, ix.user.id, toInt(a.pos));
    await say(ix, `${critter(res.species)} leaves slot ${res.pos}.${res.unequipped ? ' Its weapon went back to your armory.' : ''}`);
}

async function doTeamSwitch(ix, a) {
    const res = await critters.switchTeam(ix.guildId, ix.user.id, toInt(a.pgid));
    await say(ix, `**${res.name}** (#${res.teamId}) is your active team now.`);
}

async function doTeamRename(ix, a) {
    const res = await critters.renameTeam(ix.guildId, ix.user.id, toInt(a.pgid), a.name || '');
    await say(ix, `Team #${res.teamId} is now called **${res.name}**.`);
}

async function doTeamDelete(ix, a) {
    const res = await critters.deleteTeam(ix.guildId, ix.user.id, toInt(a.pgid));
    await say(ix, `Team #${toInt(a.pgid)} is gone.${res.activeTeamId ? ` Your active team is #${res.activeTeamId}.` : ''}`);
}

async function doEquip(ix, a) {
    const res = await critters.equipWeapon(ix.guildId, ix.user.id, toInt(a.pos), toInt(a.uwid));
    const bits = [`${critter(res.species)} now holds ${res.weapon.type.emoji} ${res.weapon.type.name} #${res.weapon.uwid}.`];
    if (res.replaced) bits.push('Its old weapon went back to your armory.');
    if (res.movedFromPid) bits.push('The weapon was taken off the critter that had it.');
    await say(ix, bits.join(' '));
}

async function doUnequip(ix, a) {
    const res = await critters.unequipWeapon(ix.guildId, ix.user.id, toInt(a.pos));
    await say(ix, res.weapon ? `${critter(res.species)} put down ${res.weapon.type.name} #${res.weapon.uwid}.` : `${critter(res.species)} was not holding anything.`);
}

async function doPetName(ix, a) {
    const res = await critters.setNickname(ix.guildId, ix.user.id, a.animal, a.nickname || '');
    await say(ix, res.nickname ? `${critter(res.species)} answers to **${res.nickname}** now.` : `${critter(res.species)} goes by its own name again.`);
}

/* ----------------------------------------------------------------------------------------------- battles */

const frameText = (f) => (Array.isArray(f) ? f.join('\n') : String(f ?? ''));

function trimLog(text, max = 3800) {
    if (text.length <= max) return text;
    return `…\n${text.slice(text.length - max)}`;
}

function rosterField(list, compact) {
    return (list || []).map(u => {
        const hp = compact ? (u.alive ? ` ${fmt(u.hp)}/${fmt(u.maxHp)} HP` : ' (down)') : '';
        return `${u.emoji} ${u.name} Lv ${u.level}${hp}`;
    }).join('\n') || 'Nobody';
}

/** The battle message for one frame (frame = null: the final view). */
function battleView({ res, aName, bName, headline, colour, extraLines = [], footer = [] }, frame = null) {
    const compact = res.settings?.display === 'compact';
    const embed = new EmbedBuilder().setTitle(`${aName} vs ${bName}`).setColor(frame == null ? colour : MOSS);
    if (frame != null) {
        embed.setDescription(`\`\`\`\n${trimLog(frameText(frame))}\n\`\`\``).setFooter({ text: 'The fight is on...' });
        return { embeds: [embed], components: [] };
    }
    const body = compact ? `Settled in ${plural(res.result.turns, 'turn')}.` : `\`\`\`\n${trimLog(res.result.log.join('\n'), 3500)}\n\`\`\``;
    embed.setDescription([`**${headline}**`, ...extraLines, '', body].join('\n'))
        .addFields(
            { name: aName, value: rosterField(res.result.final.team1, compact).slice(0, 1024), inline: true },
            { name: bName, value: rosterField(res.result.final.team2, compact).slice(0, 1024), inline: true },
        )
        .setFooter({ text: [`${plural(res.result.turns, 'turn')}`, ...footer].filter(Boolean).join(' · ') });
    const files = res.settings?.logs ? [new AttachmentBuilder(Buffer.from(res.result.log.join('\n'), 'utf8'), { name: 'battle-log.txt' })] : [];
    return { embeds: [embed], components: [], files };
}

/** Play the frames (speed short/lengthy) on `msg`, then the final view. */
async function playBattle(ix, msg, view) {
    const frames = view.res.frames || [];
    let target = msg;
    for (const f of frames) {
        if (target?.edit) await target.edit({ ...battleView(view, f), content: '', allowedMentions: { parse: [] } }).catch(() => {});
        else target = await say(ix, battleView(view, f), { fetch: true });
        await sleep(critters.BATTLE_FRAME_DELAY_MS);
    }
    const final = battleView(view);
    if (target?.edit) {
        const ok = await target.edit({ ...final, content: '', allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
        if (ok) return target;
    }
    return say(ix, final, { fetch: true });
}

async function announceCrate(ix, drop, userId) {
    if (!drop?.dropped) return;
    const text = `<@${userId}> found a weapon crate in the dust after the fight. \`[${drop.count}/${drop.max}]\` today, resets ${after(drop.resetsInMs)}. Open it with \`owo crate\`.`;
    await (ix.channel?.send ? ix.channel.send({ content: text, allowedMentions: { parse: [] } }) : say(ix, text)).catch(() => {});
}

async function battleCpu(ix) {
    const res = await critters.battleCpu(ix.guildId, ix.user.id);
    const headline = res.outcome === 'win' ? 'Victory.' : res.outcome === 'loss' ? 'Defeat.' : 'A draw.';
    const extra = [];
    if (res.result.onMargin) extra.push('Nobody was left standing on one side, so it went to whoever had more left.');
    if (res.reward) extra.push(`+${acorns(res.reward.amount)} for the win.`);
    const footer = [res.record ? `streak ${res.record.streak}` : null];
    await playBattle(ix, null, {
        res, aName: res.playerTeam.name, bName: res.cpuTeam.name, headline,
        colour: res.outcome === 'win' ? WIN : res.outcome === 'loss' ? LOSS : DRAW, extraLines: extra,
        footer: [...footer, res.settings?.logs ? 'full log attached' : null],
    });
    await announceCrate(ix, res.crateDrop, ix.user.id);
}

/* PvP: one live challenge per pair, answered by buttons or `owo ab` / `owo db` in the same channel. */
const liveDuels = new Map(); // `${guildId}:${challengerId}:${opponentId}` -> { finish(answer) }
const duelKey = (g, c, o) => `${g}:${c}:${o}`;

async function finishAccepted(ix, msg, { challenger, opponent }) {
    let res;
    try {
        res = await critters.acceptChallenge({
            guildId: ix.guildId, challengerId: challenger.id, opponentId: opponent.id,
            challengerName: nameOf(ix, challenger), opponentName: nameOf(ix, opponent),
        });
    } catch (err) {
        const text = critters.isCritterError(err) ? err.message : FAILED;
        if (!critters.isCritterError(err)) logger.error('[critters] duel failed', { guildId: ix.guildId, error: err.message });
        if (msg?.edit) await msg.edit({ content: text, embeds: [], components: [], allowedMentions: { parse: [] } }).catch(() => {});
        else await say(ix, text);
        return;
    }
    const winner = res.winnerId === challenger.id ? challenger : res.winnerId === opponent.id ? opponent : null;
    if (winner && !winner.bot) awardAchievement(ix, 'duel_winner', { userId: winner.id });
    const headline = winner ? `${nameOf(ix, winner)} wins.` : 'A draw.';
    const extra = [];
    if (res.bet > 0) {
        if (res.payoutFailed) extra.push('The payout did not go through. Both stakes will be refunded automatically within a few minutes.');
        else if (res.settlement?.draw) extra.push(`Both stakes of ${acorns(res.bet)} went back.`);
        else if (winner) extra.push(`${nameOf(ix, winner)} takes the pot of ${acorns(res.bet * 2)}.`);
    }
    if (res.reward) extra.push(`+${acorns(res.reward.amount)} prize for the winner.`);
    const h = res.headToHead;
    extra.push(`Head to head: ${nameOf(ix, challenger)} ${h.challengerWins} · ${nameOf(ix, opponent)} ${h.opponentWins} · draws ${h.ties}`);
    await playBattle(ix, msg, {
        res, aName: res.challengerTeam.name, bName: res.opponentTeam.name, headline,
        colour: winner ? WIN : DRAW, extraLines: extra, footer: [res.settings?.logs ? 'full log attached' : null],
    });
    await announceCrate(ix, res.crateDrop, challenger.id);
}

const DUEL_ENDINGS = {
    decline: (o) => `${o} said no to the battle.`,
    withdraw: () => 'The challenge was withdrawn.',
    timeout: () => 'Nobody answered the challenge in time.',
};

async function startDuel(ix, a) {
    const opponent = await requireUser(ix, a.target, 'Mention who you want to battle, for example `owo battle @Sam 500`.');
    const bet = toInt(a.bet) || 0;
    if (bet < 0) throw new critters.CritterError('BAD_BET', 'A bet cannot be negative.');
    const g = ix.guildId;
    const challenger = ix.user;
    const ch = await critters.openChallenge({
        guildId: g, challengerId: challenger.id, opponentId: opponent.id, bet, channelId: ix.channelId,
        opponentIsBot: !!opponent.bot, opponentName: nameOf(ix, opponent),
    });
    const nonce = String(ix.id || Date.now());
    const h = ch.headToHead;
    const embed = new EmbedBuilder().setTitle(`${nameOf(ix, challenger)} wants a battle`).setColor(MOSS)
        .setDescription([
            ch.bet > 0 ? `Each side puts in ${acorns(ch.bet)}; the winner takes ${acorns(ch.pot || ch.bet * 2)}.` : 'A friendly battle, nothing at stake.',
            `Head to head so far: ${h.challengerWins} · ${h.opponentWins} · draws ${h.ties}`,
            `Answer ${ts(ch.expiresAt)} at the latest, with the buttons or \`owo ab\` / \`owo db\` here.`,
        ].join('\n'));
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`critter_duel_yes:${nonce}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`critter_duel_no:${nonce}`).setLabel('Decline').setStyle(ButtonStyle.Secondary),
    );
    const msg = await say(ix, {
        content: `<@${opponent.id}>`, embeds: [embed], components: [row], allowedMentions: { users: [opponent.id], repliedUser: false },
    }, { fetch: true });
    if (msg?.id) await critters.setChallengeMessage(g, challenger.id, opponent.id, msg.id).catch(() => {});

    const key = duelKey(g, challenger.id, opponent.id);
    let done = false;
    let collector = null;
    const finish = async (answer) => {
        if (done) return;
        done = true;
        liveDuels.delete(key);
        try { collector?.stop('answered'); } catch { /* already stopped */ }
        if (answer === 'accept') return finishAccepted(ix, msg, { challenger, opponent });
        const r = await critters.cancelChallenge(g, challenger.id, opponent.id, { reason: answer }).catch(() => null);
        const refunded = r?.refunded && (r.refunded.sender > 0 || r.refunded.receiver > 0);
        const text = `${DUEL_ENDINGS[answer](nameOf(ix, opponent))}${refunded ? ' The bet went back.' : ''}`;
        if (msg?.edit) await msg.edit({ content: text, embeds: [], components: [], allowedMentions: { parse: [] } }).catch(() => {});
        else await say(ix, text).catch(() => {});
    };
    liveDuels.set(key, { finish, channelId: ix.channelId });
    if (!msg?.createMessageComponentCollector) return;
    collector = msg.createMessageComponentCollector({ time: critters.CHALLENGE_WINDOW_SECONDS * 1000 });
    collector.on('collect', async (b) => {
        if (!b.customId.endsWith(`:${nonce}`)) return;
        const yes = b.customId.startsWith('critter_duel_yes');
        if (b.user.id === opponent.id) {
            await b.deferUpdate().catch(() => {});
            return finish(yes ? 'accept' : 'decline');
        }
        if (b.user.id === challenger.id) {
            if (yes) return b.reply({ content: `${nameOf(ix, opponent)} has to accept, not you.`, flags: MessageFlags.Ephemeral }).catch(() => {});
            await b.deferUpdate().catch(() => {});
            return finish('withdraw');
        }
        return b.reply({ content: 'This battle is between two other members.', flags: MessageFlags.Ephemeral }).catch(() => {});
    });
    collector.on('end', (_c, reason) => { if (reason !== 'answered') finish('timeout').catch(() => {}); });
}

async function doBattle(ix, a) {
    if (a.target) return startDuel(ix, a);
    if (toInt(a.bet)) throw new critters.CritterError('BAD_BET', 'Bets only work against another member. Leave the bet off to fight the wild.');
    return battleCpu(ix);
}

/** `owo ab` / `owo db`: answer a challenge from chat, in the channel it was made in. */
async function doBattleAnswer(ix, a) {
    const accept = a.answer === 'accept';
    const row = await critters.findPendingChallenge(ix.guildId, ix.user.id, { channelId: ix.channelId });
    if (!row) return say(ix, 'There is no battle challenge waiting on you.');
    const iAmOpponent = row.opponentId === ix.user.id;
    if (accept && !iAmOpponent) return say(ix, 'Only the member who was challenged can accept.');
    ix.message?.react?.('\u{1F44D}').catch(() => {});
    const live = liveDuels.get(duelKey(ix.guildId, row.challengerId, row.opponentId));
    if (live) return live.finish(accept ? 'accept' : (iAmOpponent ? 'decline' : 'withdraw'));
    // The bot restarted since the challenge was posted: answer it directly.
    const stored = await fetchMessage(ix, row.channelId, row.messageId);
    if (!accept) {
        const r = await critters.cancelChallenge(ix.guildId, row.challengerId, row.opponentId, { reason: iAmOpponent ? 'decline' : 'withdraw' });
        const refunded = r?.refunded && (r.refunded.sender > 0 || r.refunded.receiver > 0);
        const text = `${iAmOpponent ? 'Challenge declined.' : 'Challenge withdrawn.'}${refunded ? ' The bet went back.' : ''}`;
        if (stored?.editable) await stored.edit({ content: text, embeds: [], components: [] }).catch(() => {});
        return say(ix, text);
    }
    const challenger = await resolveUser(ix, row.challengerId);
    return finishAccepted(ix, stored?.editable ? stored : null, { challenger: challenger || { id: row.challengerId }, opponent: ix.user });
}

async function doBattleSettings(ix, a) {
    const patch = a.text && String(a.text).trim() ? String(a.text) : Object.fromEntries(Object.entries({ display: a.display, speed: a.speed, logs: a.logs }).filter(([, v]) => v != null));
    const s = (typeof patch === 'string' || Object.keys(patch).length)
        ? await critters.setBattleSettings(ix.guildId, ix.user.id, patch)
        : await critters.getBattleSettings(ix.guildId, ix.user.id);
    await say(ix, [
        '**Your battle settings**',
        `Display: ${s.display} (text = the full log, compact = just the result)`,
        `Speed: ${s.speedName} (instant, short or lengthy)`,
        `Attach the log as a file: ${s.logs ? 'yes' : 'no'}`,
        '-# Change them with `owo bs display=compact speed=short logs=on`.',
    ].join('\n'));
}

/* ----------------------------------------------------------------------------------------------- quests, boss */

function questLines(list) {
    return list.map(qd => {
        const prize = qd.prize === 'currency' ? acorns(qd.prizeAmount) : plural(qd.prizeAmount, qd.prize === 'crate' ? 'weapon crate' : qd.prize === 'lootbox' ? 'lootbox' : 'shard', qd.prize === 'lootbox' ? 'lootboxes' : undefined);
        const state = qd.claimed ? 'claimed' : qd.complete ? 'ready to claim' : `${fmt(qd.progress)}/${fmt(qd.target)}`;
        return `**${qd.slot}.** ${qd.label} · ${state} · prize: ${prize}`;
    }).join('\n');
}

/** Adventurer and Quest Master count every quest claimed (and /rpg quests completed), H-817. */
function awardQuests(ix, n) {
    if (!(n > 0)) return;
    awardAchievement(ix, 'first_quest', { progress: n });
    awardAchievement(ix, 'quest_master', { progress: n });
}

async function doQuest(ix, a) {
    const slot = toInt(a.slot);
    const action = String(a.action || '').toLowerCase();
    if (action === 'claim-all' || action === 'claimall') {
        const res = await critters.claimAllQuests(ix.guildId, ix.user.id);
        const n = Array.isArray(res.claimed) ? res.claimed.length : Number(res.claimed) || 0;
        awardQuests(ix, n);
        return say(ix, `${n ? `Claimed ${plural(n, 'quest')}.` : 'Nothing was ready to claim.'}\n${questLines(res.quests || [])}`);
    }
    if (slot) {
        await critters.claimQuest(ix.guildId, ix.user.id, slot);
        awardQuests(ix, 1);
        const list = await critters.viewQuests(ix.guildId, ix.user.id);
        return say(ix, `Quest ${slot} claimed. A new one took its place.\n${questLines(list)}`);
    }
    const list = await critters.viewQuests(ix.guildId, ix.user.id);
    return say(ix, `**Your quests**\n${questLines(list)}\n-# Claim with \`owo quest <slot>\` or \`owo quest claim-all\`.`);
}

async function doBoss(ix, a, { admin }) {
    const action = String(a.action || 'view').toLowerCase();
    if (action === 'spawn') {
        if (!admin) throw new critters.CritterError('NOT_ALLOWED', 'Calling a boss needs the **Manage Server** permission.');
        const boss = await critters.spawnBoss(ix.guildId, ix.channelId);
        await say(ix, 'A boss is on its way.', { ephemeral: true });
        return postBoss(ix, boss);
    }
    if (action === 'fight' || action === 'f') {
        const res = await critters.fightBoss(ix.guildId, ix.user.id);
        const stored = await fetchMessage(ix, res.boss.channelId, res.boss.messageId);
        if (stored?.editable) await stored.edit(critters.bossMessage(res.boss)).catch(() => {});
        const lines = [`Your team hit the boss for **${fmt(res.damage)}** (your total: ${fmt(res.yourTotal)}).`];
        if (res.wiped) lines.push('It knocked your whole team out. You are done with this boss.');
        if (res.killed) lines.push('That was the blow that brought it down.');
        if (res.yourPayout) lines.push(`Your share: ${acorns(res.yourPayout.payout)}${res.yourPayout.top ? ' (top damage bonus included)' : ''}.`);
        return say(ix, lines.join('\n'));
    }
    const boss = await critters.getActiveBoss(ix.guildId);
    if (!boss) return say(ix, 'No boss is roaming here right now. Hunting sometimes wakes one up.');
    return say(ix, critters.bossMessage(boss));
}

/* ----------------------------------------------------------------------------------------------- passive play */

async function doRanch(ix) {
    const r = await critters.ranchStatus(ix.guildId, ix.user.id);
    await say(ix, [
        `**Ranch** · ${plural(r.teamSize, 'critter')} on your active team earn ${acorns(r.ratePerHour)} an hour.`,
        `Waiting: ${acorns(r.pending)} (${r.hours}/${r.cap} hours). ${r.nextInMs != null ? `Next hour ticks ${after(r.nextInMs)}.` : ''}`.trim(),
        '-# Collect with `owo ranch-claim`. Income stops piling up after 24 hours.',
    ].join('\n'));
}

async function doRanchClaim(ix) {
    const r = await critters.claimRanch(ix.guildId, ix.user.id);
    if (r.started) return say(ix, 'Your ranch clock starts now. Come back in an hour or more to collect.');
    if (!r.paid) return say(ix, 'Your active team earns nothing on the ranch yet. Put some critters on it.');
    await say(ix, `You collect ${acorns(r.paid)} for ${plural(r.hours, 'hour')} of ranch work. Balance: ${acorns(r.balance)}.`);
}

async function doAutohunt(ix, a) {
    const action = String(a.action || 'status').toLowerCase();
    const g = ix.guildId; const u = ix.user.id;
    if (action === 'enable' || action === 'on' || action === 'start') {
        const r = await critters.enableAutohunt(g, u);
        return say(ix, `Autohunt is on. Your critters go hunting every ${Math.round(r.intervalMs / 60000)} minutes, up to ${r.cap} trips before you collect with \`owo autohunt claim\`.`);
    }
    if (action === 'disable' || action === 'off' || action === 'stop') {
        const r = await critters.disableAutohunt(g, u);
        return say(ix, r.disabled ? 'Autohunt is off. Anything you had not collected is gone.' : 'Autohunt was already off.');
    }
    if (action === 'claim' || action === 'collect') {
        const r = await critters.claimAutohunt(g, u);
        const found = r.catches.map(c => `${c.species.emoji}${c.count > 1 ? `×${c.count}` : ''}`).join(' ');
        return say(ix, `Your critters come back from ${plural(r.queued, 'trip')} with ${found} and +${acorns(r.currency)}. Lifetime: ${plural(r.lifetime, 'trip')}.`);
    }
    const s = await critters.autohuntStatus(g, u);
    if (!s.enabled) return say(ix, 'Autohunt is off. Turn it on with `owo autohunt enable`.');
    return say(ix, `Autohunt is on: ${s.queued}/${s.cap} trips waiting${s.queued < s.cap && s.nextInMs != null ? `, the next one ${after(s.nextInMs)}` : ''}. Lifetime: ${plural(s.lifetime, 'trip')}.`);
}

async function doLuck(ix) {
    let r;
    try {
        r = await critters.rollLuck(ix.guildId, ix.user.id);
    } catch (err) {
        if (critters.isCritterError(err) && err.code === 'COOLDOWN') return say(ix, `You already tried your luck today. Next roll ${ts(err.data.readyAt)}.`);
        throw err;
    }
    const prize = r.prize.kind === 'crate' ? plural(r.prize.amount, 'weapon crate') : acorns(r.prize.amount);
    const big = r.prize.key === 'jackpot' ? ' Jackpot.' : '';
    await say(ix, `The dice land and you win ${prize}.${big}\nLuck rolls so far: ${fmt(r.rolls)} · luck points: ${fmt(r.luckPoints)}`);
}

/* ----------------------------------------------------------------------------------------------- social */

async function doPrayCurse(ix, a, kind) {
    const target = await resolveUser(ix, a.target);
    const t = target && target.id !== ix.user.id ? target : null;
    const res = await critters.prayOrCurse(ix.guildId, ix.user.id, kind, t?.id || null, { targetIsBot: !!t?.bot });
    const line = String(res.line || '').replaceAll('{you}', `**${nameOf(ix, ix.user)}**`).replaceAll('{them}', t ? `**${nameOf(ix, t)}**` : 'them');
    const tail = t ? ` ${nameOf(ix, t)} is at ${fmt(res.targetLuck)}.` : '';
    await say(ix, `${line}\nYour luck: ${fmt(res.luck)}.${tail}`);
}

async function doCookie(ix, a) {
    const target = await resolveUser(ix, a.target);
    if (!target || target.id === ix.user.id) {
        if (target) throw new critters.CritterError('SELF', 'Cookies are for other people.');
        const s = await critters.cookieStatus(ix.guildId, ix.user.id);
        return say(ix, `You have received ${plural(s.received, 'cookie')}. ${s.canGive ? 'Your cookie for today is still yours to give: `owo cookie @someone`.' : `You gave today's cookie away; the next one is ready ${after(s.msUntilNext)}.`}`);
    }
    const res = await critters.giveCookie(ix.guildId, ix.user.id, target.id, { targetIsBot: !!target.bot });
    await say(ix, `You gave <@${target.id}> a cookie. They have ${plural(res.targetCookies, 'cookie')} now.`);
}

async function doCount(ix, a) {
    const user = (await resolveUser(ix, a.target)) || ix.user;
    const c = await critters.pointsCard(ix.guildId, user.id);
    await say(ix, [
        `**${nameOf(ix, user)}** has said owo or uwu ${plural(c.here, 'time')} here${c.rankHere ? ` (place ${c.rankHere})` : ''}.`,
        `Across every server: ${fmt(c.global)} · this server in total: ${fmt(c.serverTotal)}.`,
    ].join('\n'));
}

async function doLottery(ix, a) {
    const amount = toInt(a.amount);
    if (!amount && !a.all) {
        const s = await critters.lotteryStatus(ix.guildId, ix.user.id);
        const last = s.last ? `Last draw: <@${s.last.winnerId}> won ${acorns(s.last.pot)} from ${plural(s.last.participants, 'player')} ${ts(s.last.drawnAt)}.` : 'No draw has happened here yet.';
        return say(ix, [
            `**Acorn lottery** · draw ${ts(s.drawAt)}`,
            `Pot ${acorns(s.pot)}, jackpot ${acorns(s.jackpot)} with the house top-up, ${plural(s.players, 'player')}.`,
            `Your tickets: ${fmt(s.entry)} (${s.chancePct}% chance). Limit ${fmt(s.cap)} per draw.`,
            last,
        ].join('\n'));
    }
    const r = await critters.enterLottery(ix.guildId, ix.user.id, { amount, all: !!a.all, channelId: ix.channelId });
    await say(ix, [
        `You bought ${plural(r.added, 'ticket')}${r.trimmed ? ` (trimmed to the ${fmt(r.cap)} limit)` : ''}. You hold ${fmt(r.total)} now.`,
        `Pot ${acorns(r.pot)}, jackpot ${acorns(r.jackpot)}, ${plural(r.players, 'player')}. Your chance: ${r.chancePct}%. Draw ${ts(r.drawAt)}.`,
    ].join('\n'));
}

/* ----------------------------------------------------------------------------------------------- shop, rings, wallpapers */

async function doShop(ix) {
    const s = await critters.shopListing(ix.guildId, ix.user.id);
    const embed = new EmbedBuilder().setTitle('The critter shop').setColor(MOSS)
        .addFields(
            { name: 'Rings (for proposals)', value: s.rings.map(r => `\`${r.shopId}\` ${r.emoji} ${r.name} · ${acorns(r.price)}`).join('\n').slice(0, 1024) },
            { name: 'Profile wallpapers', value: s.wallpapers.map(w => `\`${w.shopId}\` ${w.name} · ${acorns(w.price)}${w.owned ? ' (yours)' : ''}`).join('\n').slice(0, 1024) },
        )
        .setFooter({ text: `You have ${critters.formatAcorns(s.balance)} · buy with owo buy <id>` });
    await say(ix, { embeds: [embed] });
}

async function doBuy(ix, a) {
    const res = await critters.buyFromShop(ix.guildId, ix.user.id, toInt(a.id));
    if (res.kind === 'ring') return say(ix, `You bought a ${res.ring.emoji} ${res.ring.name} (${plural(res.owned, 'ring')} of that kind now). Balance: ${acorns(res.balance)}.`);
    return say(ix, `You bought the **${res.wallpaper.name}** wallpaper. Put it on with \`owo wallpaper ${res.wallpaper.shopId}\`. Balance: ${acorns(res.balance)}.`);
}

async function doRingShop(ix) {
    const rings = critters.ringCatalog();
    await say(ix, ['**Rings** (all rings work the same; buy with `owo ring buy <id>`)', ...rings.map(r => `\`${r.id}\` ${r.emoji} ${r.name} · ${acorns(r.price)} · sells back for ${acorns(r.sellPrice)}`)].join('\n'));
}

async function doRingBuy(ix, a) {
    const res = await critters.buyRing(ix.guildId, ix.user.id, toInt(a.id));
    await say(ix, `You bought a ${res.ring.emoji} ${res.ring.name}. Balance: ${acorns(res.balance)}.`);
}

async function doRingSell(ix, a) {
    const res = await critters.sellRing(ix.guildId, ix.user.id, toInt(a.id));
    await say(ix, `You sold a ${res.ring.name} for ${acorns(res.price)}. Balance: ${acorns(res.balance)}.`);
}

async function doRingInventory(ix) {
    const list = await critters.ringInventory(ix.guildId, ix.user.id);
    await say(ix, list.length
        ? ['**Your rings**', ...list.map(r => `\`${r.ring.id}\` ${r.ring.emoji} ${r.ring.name} ×${r.qty} · sells for ${acorns(r.sellPrice)} each`)].join('\n')
        : 'You have no rings. See `owo ring shop`.');
}

async function doWallpaperShop(ix, a) {
    const id = toInt(a.id);
    if (!id) return doShop(ix);
    const wp = critters.wallpaperPreview(id);
    const png = await critters.renderWallpaper(wp.id).catch(() => null);
    const embed = new EmbedBuilder().setTitle(`${wp.name} · ${acorns(wp.price)}`).setDescription(`${wp.description}\nBuy it with \`owo buy ${wp.shopId}\`.`)
        .setColor(parseInt(String(wp.colors?.[0] || '#5f7a4f').slice(1), 16) || MOSS);
    const files = [];
    if (png) { files.push(new AttachmentBuilder(png, { name: 'wallpaper.png' })); embed.setImage('attachment://wallpaper.png'); }
    await say(ix, { embeds: [embed], files });
}

async function doWallpaperBuy(ix, a) {
    const res = await critters.buyWallpaper(ix.guildId, ix.user.id, toInt(a.id));
    await say(ix, `The **${res.wallpaper.name}** wallpaper is yours. Put it on with \`owo wallpaper ${res.wallpaper.shopId}\`. Balance: ${acorns(res.balance)}.`);
}

async function doWallpaperEquip(ix, a) {
    const res = await critters.equipWallpaper(ix.guildId, ix.user.id, a.id);
    await say(ix, res.wallpaper ? `Your profile now shows **${res.wallpaper.name}**.` : 'Your profile is back to plain.');
}

async function doWallpaperUnequip(ix) {
    await critters.unequipWallpaper(ix.guildId, ix.user.id);
    await say(ix, 'Your profile is back to plain.');
}

async function doWallpaperOwned(ix) {
    const o = await critters.ownedWallpapers(ix.guildId, ix.user.id);
    await say(ix, o.owned.length
        ? ['**Your wallpapers**', ...o.owned.map(w => `\`${w.shopId}\` ${w.name}${w.id === o.equippedId ? ' (on your profile)' : ''}`)].join('\n')
        : 'You have no wallpapers yet. See `owo shop`.');
}

/** Chat `owo wallpaper [id|none]`: no id lists, none/off/remove unequips, an id equips. */
async function doWallpaperChat(ix, a) {
    const raw = String(a.id ?? '').trim().toLowerCase();
    if (!raw) return doWallpaperOwned(ix);
    return doWallpaperEquip(ix, { id: raw });
}

/* ----------------------------------------------------------------------------------------------- marriage */

async function confirm(ix, text) {
    const nonce = String(ix.id || Date.now());
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`critter_confirm_yes:${nonce}`).setLabel('Yes').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`critter_confirm_no:${nonce}`).setLabel('Never mind').setStyle(ButtonStyle.Secondary),
    );
    const msg = await say(ix, { content: text, components: [row] }, { fetch: true });
    if (!msg?.createMessageComponentCollector) return { yes: false, msg };
    return new Promise((resolve) => {
        const col = msg.createMessageComponentCollector({ time: 60 * 1000 });
        col.on('collect', async (b) => {
            if (!b.customId.endsWith(`:${nonce}`)) return;
            if (b.user.id !== ix.user.id) return b.reply({ content: 'This choice belongs to someone else.', flags: MessageFlags.Ephemeral }).catch(() => {});
            await b.deferUpdate().catch(() => {});
            col.stop('answered');
            resolve({ yes: b.customId.startsWith('critter_confirm_yes'), msg });
        });
        col.on('end', (_c, reason) => { if (reason !== 'answered') resolve({ yes: false, msg, timedOut: true }); });
    });
}

const closeConfirm = (msg, text) => msg?.edit?.({ content: text, components: [], allowedMentions: { parse: [] } }).catch(() => {});

async function doPropose(ix, a) {
    const target = await requireUser(ix, a.target, 'Mention who you want to marry and pick a ring, for example `owo marry @Sam 2`.');
    const ringId = toInt(a.ring ?? a.id);
    if (!ringId) throw new critters.CritterError('NO_RING', 'Pick the ring you are offering, for example `owo marry @Sam 2`. See `owo ring shop`.');
    const res = await critters.propose(ix.guildId, ix.user.id, target.id, ringId, {
        channelId: ix.channelId, targetIsBot: !!target.bot, targetIsThisBot: target.id === ix.client?.user?.id,
    });
    if (res.kind === 'ring-change') {
        const c = await confirm(ix, `Swap your ${res.currentRing?.name || 'ring'} for a ${res.newRing.name}? The old ring breaks in the process.`);
        if (!c.yes) return closeConfirm(c.msg, c.timedOut ? 'No answer, so the rings stay as they are.' : 'The rings stay as they are.');
        const done = await critters.changeRing(ix.guildId, ix.user.id, target.id, ringId);
        return closeConfirm(c.msg, `You and <@${target.id}> now wear ${done.newRing.emoji} ${done.newRing.name}s.`);
    }
    await say(ix, {
        content: `<@${target.id}>, **${nameOf(ix, ix.user)}** is down on one knee with a ${res.proposal.ring.emoji} ${res.proposal.ring.name}. Answer with \`owo am\` to say yes or \`owo dm\` to say no.`,
        allowedMentions: { users: [target.id], repliedUser: false },
    });
}

async function doMarryAccept(ix) {
    const res = await critters.acceptProposal(ix.guildId, ix.user.id);
    await say(ix, `<@${res.partnerId}> and <@${ix.user.id}> are married. ${res.ring?.emoji || ''} Claim your dailies on the same day for a couple bonus.`.replace('  ', ' '));
}

async function doMarryDecline(ix) {
    const res = await critters.declineProposal(ix.guildId, ix.user.id);
    await say(ix, res.kind === 'declined' ? `You turned the proposal down. The ${res.ring?.name || 'ring'} went back to <@${res.sender}>.` : `You withdrew your proposal and got your ${res.ring?.name || 'ring'} back.`);
}

async function doDivorce(ix) {
    const status = await critters.marriageStatus(ix.guildId, ix.user.id);
    if (!status.married) throw new critters.CritterError('NOT_MARRIED', 'You are not married.');
    const c = await confirm(ix, `Really split up with <@${status.partnerId}>? The ring is lost for good.`);
    if (!c.yes) return closeConfirm(c.msg, c.timedOut ? 'No answer, so nothing changed.' : 'Nothing changed.');
    const res = await critters.divorce(ix.guildId, ix.user.id);
    return closeConfirm(c.msg, `You and <@${res.partnerId}> have gone your separate ways.`);
}

async function doMarryStatus(ix) {
    const s = await critters.marriageStatus(ix.guildId, ix.user.id);
    if (s.married) {
        const embed = new EmbedBuilder().setColor(0xd98ba6).setTitle(`${nameOf(ix, ix.user)} is married`)
            .setDescription(`To <@${s.partnerId}> with a ${s.ring?.emoji || ''} ${s.ring?.name || 'ring'}.\n*${s.compliment}*`)
            .addFields(
                { name: 'Since', value: ts(s.marriedAt, 'D'), inline: true },
                { name: 'Days together', value: fmt(s.daysMarried), inline: true },
                { name: 'Dailies together', value: fmt(s.dailies), inline: true },
            );
        return say(ix, { embeds: [embed] });
    }
    const lines = [];
    if (s.incoming) lines.push(`<@${s.incoming.sender}> proposed to you with a ${s.incoming.ring?.name || 'ring'}. Answer with \`owo am\` or \`owo dm\`.`);
    if (s.outgoing) lines.push(`You proposed to <@${s.outgoing.receiver}> and are waiting for an answer. \`owo dm\` withdraws it.`);
    if (!lines.length) lines.push('You are single. Buy a ring (`owo ring shop`) and propose with `owo marry @someone <ring id>`.');
    return say(ix, lines.join('\n'));
}

/** Chat `owo marry [@user <ring>]`: status without a target, otherwise a proposal. */
async function doMarryChat(ix, a) {
    if (!a.target) return doMarryStatus(ix);
    return doPropose(ix, a);
}

/* ----------------------------------------------------------------------------------------------- profile */

async function doProfileView(ix, a) {
    const user = (await resolveUser(ix, a.target)) || ix.user;
    const v = await critters.profileView(ix.guildId, user.id, { viewerId: ix.user.id });
    if (v.hidden) return say(ix, `${nameOf(ix, user)} keeps their critters profile private.`, { ephemeral: true });
    const p = v.profile;
    const color = parseInt(String(v.color || '#5f7a4f').replace('#', ''), 16) || MOSS;
    const luck = v.luck ? `${fmt(v.luck.points)}${v.luck.praysReceived || v.luck.cursesReceived ? ` (${fmt(v.luck.praysReceived)} prays, ${fmt(v.luck.cursesReceived)} curses received)` : ''}` : '0';
    const embed = new EmbedBuilder().setColor(color)
        .setAuthor({ name: nameOf(ix, user), iconURL: user.displayAvatarURL?.({ size: 128 }) || undefined })
        .setTitle(p.title || null)
        .setDescription(p.about || null)
        .addFields(
            { name: 'Kinds found', value: fmt(v.uniqueAnimals), inline: true },
            { name: 'Caught in all', value: fmt(v.totalCatches), inline: true },
            { name: 'Acorns', value: acorns(v.balance), inline: true },
            { name: 'Luck', value: luck, inline: true },
            { name: 'Cookies', value: fmt(v.cookies), inline: true },
            { name: 'Married', value: v.marriage ? `to <@${v.marriage.partnerId}>, ${plural(v.marriage.days, 'day')}, ${plural(v.marriage.dailies, 'shared daily', 'shared dailies')}` : 'Single', inline: true },
            { name: 'Rarest find', value: v.rarest ? critter(v.rarest) : 'None yet', inline: true },
        );
    const files = [];
    if (v.wallpaper) {
        const png = await critters.renderProfileCard({
            wallpaperId: v.wallpaper.id, avatarUrl: user.displayAvatarURL?.({ size: 256, extension: 'png' }), name: nameOf(ix, user),
            title: p.title || '', about: p.about || '',
            tiles: [
                { label: 'Acorns', value: fmt(v.balance) }, { label: 'Luck', value: fmt(v.luck?.points) },
                { label: 'Cookies', value: fmt(v.cookies) }, { label: 'Kinds', value: fmt(v.uniqueAnimals) },
            ],
        }).catch(() => null);
        if (png) { files.push(new AttachmentBuilder(png, { name: 'profile.png' })); embed.setImage('attachment://profile.png'); }
    } else {
        if (user.displayAvatarURL) embed.setThumbnail(user.displayAvatarURL({ size: 128 }));
        if (user.id === ix.user.id) embed.setFooter({ text: 'Dress it up with a wallpaper from owo shop' });
    }
    await say(ix, { embeds: [embed], files });
}

async function doProfileAbout(ix, a) {
    const r = await critters.setAbout(ix.guildId, ix.user.id, a.text || '');
    await say(ix, r.about ? 'Your about text is saved.' : 'Your about text is cleared.', { ephemeral: true });
}

async function doProfileTitle(ix, a) {
    const r = await critters.setTitle(ix.guildId, ix.user.id, a.text || '');
    await say(ix, r.title ? `Your title is now "${r.title}".` : 'Your title is cleared.', { ephemeral: true });
}

async function doProfileAccent(ix, a) {
    const r = await critters.setAccent(ix.guildId, ix.user.id, a.color, a.color2);
    await say(ix, `Your profile colour is ${r.accent}${r.accent2 ? ` with ${r.accent2}` : ''}.`, { ephemeral: true });
}

async function doProfilePrivacy(ix, a) {
    const r = await critters.setPrivacy(ix.guildId, ix.user.id, !!a.private);
    await say(ix, r.isPrivate ? 'Your profile is private now. Only you can see it.' : 'Your profile is visible to everyone again.', { ephemeral: true });
}

/* ----------------------------------------------------------------------------------------------- admin, misc */

async function doToggle(ix, a) {
    if (!ix.guildId) throw new critters.CritterError('NO_GUILD', 'Run this inside the server you want to change.');
    const cfg = await critters.setEnabled(ix.guildId, !!a.enabled);
    await say(ix, cfg.enabled
        ? 'The critters game is on. Members can start with `owo hunt`.'
        : 'The critters game is off. Nothing is deleted; turning it back on picks up where everyone left off.', { ephemeral: true });
}

async function doOwoify(ix, a) {
    const text = String(a.text || '').trim();
    if (!text) throw new critters.CritterError('BAD_INPUT', 'Give me some text to owoify.');
    await say(ix, { content: owoifyText(text) });
}

export const HELP_TEXT = [
    '**Critters** · catch critters, build a team, battle, and collect acorns.',
    'Start with `owo hunt` (or `owoh`), then `owo zoo`, `owo daily`, `owo team add <critter>` and `owo battle`.',
    'Money: `owo balance`, `owo give @x 100`, `owo lottery`, `owo shop`. Gear: `owo crate`, `owo weapon`, `owo lootbox`, `owo gems`.',
    'Friends: `owo pray`, `owo cookie @x`, `owo marry @x <ring>`, `owo profile`. Every command also works as `/owo <command>`.',
].join('\n');

async function doHelp(ix) {
    await say(ix, HELP_TEXT);
}

/* ----------------------------------------------------------------------------------------------- the table */

/**
 * name -> { key: feature key (or fn(args)), run, admin?, gate? }.
 * key null = not feature-gated; gate false = no gates at all (the toggle, owoify on its own command).
 */
export const ACTIONS = Object.freeze({
    hunt: { key: 'hunt', run: doHunt },
    zoo: { key: 'zoo', run: doZoo },
    leaderboard: { key: 'leaderboard', run: doLeaderboard },
    'social-top': { key: 'top', run: doSocialTop },
    catalog: { key: 'catalog', run: doCatalog },
    sell: { key: 'sell', run: doSell },
    sacrifice: { key: 'sacrifice', run: doSacrifice },
    feed: { key: 'feed', run: doFeed },
    stats: { key: 'stats', run: doStats },
    daily: { key: 'daily', run: doDaily },
    balance: { key: 'balance', run: doBalance },
    give: { key: 'give', run: doGive },
    'give-limits': { key: 'give-limits', run: doGiveLimits },
    transactions: { key: 'transactions', run: doTransactions },
    drop: { key: 'drop', run: doDrop },
    pickup: { key: 'pickup', run: doPickup },
    weapon: { key: 'weapon', run: doWeapon },
    crate: { key: 'crate', run: doCrate },
    shards: { key: 'shards', run: doShards },
    dismantle: { key: 'dismantle', run: doDismantle },
    forge: { key: 'forge', run: doForge },
    favorite: { key: 'favorite', run: doFavorite },
    'forge-prices': { key: 'forge-prices', run: doForgePrices },
    lootbox: { key: 'lootbox', run: doLootbox },
    gems: { key: 'gems', run: doGems },
    use: { key: 'use', run: doUse },
    'grant-crate': { key: null, admin: true, run: doGrantCrate },
    'team-view': { key: 'team', run: doTeamView },
    'team-create': { key: 'team-create', run: doTeamCreate },
    'team-add': { key: 'team-add', run: doTeamAdd },
    'team-remove': { key: 'team-remove', run: doTeamRemove },
    'team-switch': { key: 'team-switch', run: doTeamSwitch },
    'team-rename': { key: 'team-rename', run: doTeamRename },
    'team-delete': { key: 'team-delete', run: doTeamDelete },
    equip: { key: 'equip', run: doEquip },
    unequip: { key: 'unequip', run: doUnequip },
    'pet-name': { key: 'pet-name', run: doPetName },
    battle: { key: 'battle', run: doBattle },
    duel: { key: 'duel', run: (ix, a) => startDuel(ix, a) },
    'battle-answer': { key: 'battle', run: doBattleAnswer },
    'battle-settings': { key: 'battle-settings', run: doBattleSettings },
    quest: { key: 'quest', run: doQuest },
    boss: { key: 'boss', run: doBoss },
    ranch: { key: 'ranch', run: doRanch },
    'ranch-claim': { key: 'ranch-claim', run: doRanchClaim },
    autohunt: { key: 'autohunt', run: doAutohunt },
    luck: { key: 'luck', run: doLuck },
    pray: { key: 'pray', run: (ix, a) => doPrayCurse(ix, a, 'pray') },
    curse: { key: 'curse', run: (ix, a) => doPrayCurse(ix, a, 'curse') },
    cookie: { key: 'cookie', run: doCookie },
    count: { key: 'count', run: doCount },
    lottery: { key: 'lottery', run: doLottery },
    shop: { key: 'shop', run: doShop },
    buy: { key: (a) => (toInt(a.id) > 200 ? 'wallpaper' : 'ring'), run: doBuy },
    'ring-shop': { key: 'ring', run: doRingShop },
    'ring-buy': { key: 'ring', run: doRingBuy },
    'ring-sell': { key: 'ring', run: doRingSell },
    'ring-inventory': { key: 'ring', run: doRingInventory },
    'wallpaper-shop': { key: 'wallpaper', run: doWallpaperShop },
    'wallpaper-buy': { key: 'wallpaper', run: doWallpaperBuy },
    'wallpaper-equip': { key: 'wallpaper', run: doWallpaperEquip },
    'wallpaper-unequip': { key: 'wallpaper', run: doWallpaperUnequip },
    'wallpaper-owned': { key: 'wallpaper', run: doWallpaperOwned },
    wallpaper: { key: 'wallpaper', run: doWallpaperChat },
    marry: { key: 'marry', run: doMarryChat },
    'marry-propose': { key: 'marry', run: doPropose },
    'marry-accept': { key: 'marry', run: doMarryAccept },
    'marry-decline': { key: 'marry', run: doMarryDecline },
    'marry-divorce': { key: 'marry', run: doDivorce },
    'marry-status': { key: 'marry', run: doMarryStatus },
    'profile-view': { key: 'profile', run: doProfileView },
    'profile-about': { key: 'profile', run: doProfileAbout },
    'profile-title': { key: 'profile', run: doProfileTitle },
    'profile-accent': { key: 'profile', run: doProfileAccent },
    'profile-privacy': { key: 'profile', run: doProfilePrivacy },
    toggle: { key: null, admin: true, gate: false, run: doToggle },
    owoify: { key: null, gate: false, run: doOwoify },
    help: { key: null, run: doHelp },
});

export const _internals = { huntText, battleView, questLines, liveDuels };
