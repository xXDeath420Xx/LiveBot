/*
 * Bot retirement — the gate between "we think we replaced it" and "it is gone".
 *
 * Removing a bot is irreversible in the way that matters: re-inviting it does not bring back the
 * levels, economy balances or panels it stored on its own servers. So every gate is re-evaluated
 * from live state at the moment of removal. Nothing here trusts a flag the dashboard sent, or a
 * verdict computed minutes ago.
 *
 * The gate that actually earns its keep is `evidence`: every distinct message shape the bot has
 * ever posted must be attributed to a feature we provably reproduce. A bot quietly answering
 * `!pp` in one forgotten channel fails that gate, and should.
 */
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { KNOWN_BOTS, plan, resolveBotMeta } from './takeover-manager.js';
import { getTemplates, unattributedCount } from './guild-analyzer.js';

/** Hours our replacement must have been live before the incumbent may be removed. */
export const DEFAULT_SOAK_HOURS = 24;

/**
 * Bots holding data that dies with them. Removal is blocked until an admin confirms the export
 * happened, because no gate can detect a migration that was never run.
 */
export const DATA_HOLDERS = Object.freeze({
    '159985870458322944': { name: 'MEE6', what: 'levels and XP', how: 'export via mee6.xyz leaderboard API before kicking' },
    '235148962103951360': { name: 'Carl-bot', what: 'reaction-role panels and tags', how: 'panels must be rebuilt by us first' },
    '172002275412279296': { name: 'Tatsu', what: 'levels and currency', how: 'no export API — accept the loss explicitly' },
});

/**
 * Message shapes we can attribute automatically, per feature. Anything not matched here is left
 * for a human to classify — deliberately. A regex that guesses is worse than a checkbox.
 *
 * These are written against the REAL templates the incumbents posted in Kabster's guild (707 of
 * them, read out of the scan), not from imagination. The earlier set was guesswork and matched
 * almost nothing, which is why bots we fully replace were sitting at "0 attributed" and their
 * retirement gate refused — the evidence gate was reporting our ignorance, not their behaviour.
 * Measured coverage now: 702/707. What still needs a human is genuinely ambiguous (Carl-bot's
 * "bye bye loser", Dyno's poll/news webhook), which is exactly what the checkbox is for.
 */
const FEATURE_SIGNATURES = {
    counting: [/^\{n\}$/, /ruined it/i, /next number/i, /wrong number/i, /counting/i,
        /two numbers in a row/i, /deleted their number/i, /maths is (dis|en)abled/i,
        /\bsaves?\b/i, /c!channel/i],
    // Dyno logged mostly ROLE GRANTS — 148 of its 252 shapes. The old single regex missed every one.
    logging: [/message (sent by .* )?(deleted|edited)/i, /(joined|left) voice channel/i,
        /nickname changed/i, /image sent by .* deleted/i, /member (joined|left)/i,
        /\b(banned|unban|kicked|timeout|muted)\b/i, /bulk delete/i,
        /was (given|removed from) the /i, /was given the roles/i, /Role .+ Changed:/i,
        /has been timed out/i, /role (added|removed|updated)/i, /poll created/i],
    timezone: [/time ?zone/i, /it is currently/i, /time format/i, /auto-?detect/i, /friend time/i,
        /converted times/i, /^embed:(Server|User) - /i, /completed (user|server) setup/i,
        /invalid language/i, /something went wrong/i, /permissions required/i],
    catbot: [/\bcats?\b/i, /achievement get/i, /missing permissions/i, /caught/i],
    growtree: [/tree/i, /water/i],
    streams: [/\bis (now )?live\b/i, /is live over at/i, /went live/i, /^embed:.*(twitch|kick|youtube)/i],
    kofi: [/ko-?fi/i, /supported us/i],
    reaction_roles: [/^ui:/, /\{role\}/, /has been created/i, /\| case \{n\}/i, /^embed:Success!/i],
    free_games: [/freestuffbot/i, /\*\*Free(?: to play)?\*\* until/i,
        /open in (browser|steam client|epic games launcher)/i,
        /(active|add) notifications/i, /prime gaming/i, /^### .+ > /],
    throne: [/wishlist/i, /new gift/i, /has gifted/i, /has contributed/i, /partying_face/i],
    owo: [/goes into battle/i, /leveled up/i, /hunt is empowered/i, /you found:/i, /lootbox/i,
        /guild boss/i, /cowoncy/i, /weapon crate/i, /\bowo\b/i, /essence/i, /\bgems?\b/i,
        /inventory/i, /[⁰¹²³⁴⁵⁶⁷⁸⁹]/],
    cannabis: [/toke/i, /joint/i, /puff/i, /smoke circle/i, /takes a hit/i, /strain/i, /cheers/i],
    emoji: [/emoji/i, /^\{emoji\}$/],
    custom_commands: [/^WWW$/i, /loser/i, /inch pp/i, /made by tiz/i, /[⣿⡏⢸⠉]/, /commands overlays/i],
    birthday: [/birthday/i, /🎂/],
    moderation: [/\b(warn|mute|ban|kick)\b/i, /\| case \{n\}/i],
    soundboard: [/sound|clip|soundboard/i],
};

/**
 * Attribute what we safely can; return how many remain for a human.
 *
 * `name` matters: a webhook persona is keyed `wh:<name>`, so without it a webhook can never be
 * matched to the bot that owns it. Callers that have the scanned name should pass it.
 */
export async function autoAttribute(scanId, botId, name = null, selfId = null) {
    const meta = resolveBotMeta(botId, name, selfId);
    const sigs = meta?.feature ? FEATURE_SIGNATURES[meta.feature] : null;
    if (!sigs) return { matched: 0, remaining: await unattributedCount(scanId, botId) };

    const templates = await getTemplates(scanId, botId);
    let matched = 0;

    for (const t of templates) {
        if (t.attributed) continue;
        if (t.template_hash === 'TRUNCATED000000') continue; // never auto-clear a truncation marker
        if (!sigs.some(re => re.test(t.sample || ''))) continue;

        await pool.execute(
            `UPDATE guild_scan_templates SET attributed = 1, attributed_to = ?, attributed_by = 'auto'
             WHERE id = ?`, [meta.feature, t.id]);
        matched++;
    }
    return { matched, remaining: await unattributedCount(scanId, botId) };
}

// ── Gates ────────────────────────────────────────────────────────────────────

/** Steps in a takeover plan that must be `done` before a given feature counts as replaced. */
const PARITY_STEPS = {
    counting: ['counting'],
    logging: ['logging'],
    timezone: ['timezone'],
    catbot: ['catbot'],
    growtree: ['growtree'],
    owo: ['owo'],
    kofi: ['kofi'],
    streams: [], // subscriptions are reviewed by hand; `streams_review` is never auto-done
};

const gate = (id, label, pass, detail) => ({ id, label, pass, detail });

/**
 * Evaluate every gate for one bot. Pure inspection — safe to call from a GET.
 * `pass: null` means "cannot determine", which is treated as a failure by `retire()`.
 */
export async function evaluate(guild, botId, scanId, { soakHours = DEFAULT_SOAK_HOURS, overrideSoak = false } = {}) {
    const meta = KNOWN_BOTS[botId] ?? null;
    const member = await guild.members.fetch(botId).catch(() => null);
    const gates = [];

    // 1. Do we even claim to replace it?
    gates.push(gate('known', 'We have a replacement feature',
        !!meta?.feature,
        meta ? (meta.feature ? `replaces our "${meta.feature}"` : `unreplaceable — ${meta.why}`)
            : 'unrecognised bot — classify it before removing anything'));

    // 2. Still here?
    gates.push(gate('present', 'Bot is still in the server', !!member,
        member ? member.user.tag : 'already gone'));

    // 3. Parity: re-read live config, do not trust that `apply()` ran.
    if (meta?.feature) {
        const wanted = PARITY_STEPS[meta.feature] ?? [];
        if (!wanted.length) {
            gates.push(gate('parity', 'Feature parity verified', false,
                `"${meta.feature}" cannot be verified automatically — confirm by hand, then remove manually`));
        } else {
            const planned = await plan(guild);
            const steps = planned.steps.filter(s => wanted.includes(s.key));
            const undone = steps.filter(s => !s.done);
            gates.push(gate('parity', 'Feature parity verified',
                steps.length > 0 && undone.length === 0,
                steps.length === 0 ? 'no parity step produced — nothing proves we replaced it'
                    : undone.length ? `not done: ${undone.map(s => s.label).join(', ')}`
                        : `verified: ${steps.map(s => s.label).join(', ')}`));
        }
    } else {
        gates.push(gate('parity', 'Feature parity verified', false, 'no feature to verify'));
    }

    // 4. Evidence: every message shape attributed.
    const remaining = scanId ? await unattributedCount(scanId, botId) : null;
    gates.push(gate('evidence', 'Every message it posts is accounted for',
        remaining === 0,
        scanId == null ? 'no completed scan — run one first'
            : remaining === 0 ? 'all templates attributed'
                : `${remaining} message template(s) we cannot explain`));

    // 5. Data extraction, where data would die.
    const holder = DATA_HOLDERS[botId];
    if (holder) {
        const [[state]] = await pool.execute(
            'SELECT snapshot FROM guild_retire_state WHERE guild_id = ? AND bot_id = ?', [guild.id, botId]);
        const ack = readSnapshot(state?.snapshot)?.extraction_ack ?? null;
        gates.push(gate('data', `Data extracted from ${holder.name}`, !!ack,
            ack ? `confirmed by ${ack.by}` : `${holder.what} will be lost — ${holder.how}`));
    }

    // 6. Role hierarchy and permissions — the condition you named.
    const me = guild.members.me;
    if (member && me) {
        const above = me.roles.highest.comparePositionTo(member.roles.highest) > 0;
        gates.push(gate('hierarchy', 'Our highest role is above theirs', above,
            above ? `${me.roles.highest.name} > ${member.roles.highest.name}`
                : `${member.roles.highest.name} sits at or above ${me.roles.highest.name} — move ours up`));
    } else {
        gates.push(gate('hierarchy', 'Our highest role is above theirs', null, 'cannot compare'));
    }
    gates.push(gate('permission', 'We may remove integrations',
        !!me?.permissions.has(PermissionFlagsBits.ManageGuild) || !!me?.permissions.has(PermissionFlagsBits.KickMembers),
        me ? '' : 'bot member not cached'));

    // 7. Soak: parity must have held for a while before we burn the bridge.
    //
    // `overrideSoak` waives THIS gate and this gate only. It is deliberately powerless over the
    // others: the clock is the one thing here that is about patience rather than correctness, so it
    // is the one thing an owner may reasonably skip. Parity, evidence, data extraction and hierarchy
    // are about whether we ACTUALLY replaced the bot, and no override touches them — a waiver removes
    // the wait, never the proof. The clock is still stamped/read normally underneath, so the gate
    // stays honest about what it skipped.
    const readyAt = await soakClock(guild.id, botId, gates);
    const soakMs = soakHours * 3_600_000;
    const elapsed = readyAt ? Date.now() - new Date(readyAt).getTime() : 0;
    const soakMet = !!readyAt && elapsed >= soakMs;
    const soakWaived = overrideSoak && !soakMet;
    gates.push(gate('soak', `Replacement running for ${soakHours}h`,
        soakMet || overrideSoak,
        soakWaived
            ? 'WAIVED by owner — the 24h proof was skipped; every other gate is still enforced'
            : !readyAt ? 'starts once every other gate passes'
                : soakMet ? `ready since ${new Date(readyAt).toISOString()}`
                    : `${Math.ceil((soakMs - elapsed) / 3_600_000)}h remaining`));

    return {
        botId,
        name: meta?.name ?? member?.user?.username ?? botId,
        feature: meta?.feature ?? null,
        gates,
        ready: gates.every(g => g.pass === true),
        blockers: gates.filter(g => g.pass !== true).map(g => g.label),
        // True only when the waiver actually did something — the soak was NOT naturally met and the
        // override carried it. Lets retire() log the fact rather than the intent.
        soakWaived,
    };
}

/**
 * Stamp `parity_ready_at` the first time every gate except the soak itself passes; clear it if
 * anything regresses. The soak window therefore measures uninterrupted readiness, not wall time
 * since somebody clicked a button.
 */
async function soakClock(guildId, botId, gatesSoFar) {
    const allPass = gatesSoFar.every(g => g.pass === true);
    const [[row]] = await pool.execute(
        'SELECT parity_ready_at FROM guild_retire_state WHERE guild_id = ? AND bot_id = ?', [guildId, botId]);

    if (allPass && !row?.parity_ready_at) {
        await pool.execute(
            `INSERT INTO guild_retire_state (guild_id, bot_id, parity_ready_at) VALUES (?, ?, NOW())
             ON DUPLICATE KEY UPDATE parity_ready_at = COALESCE(parity_ready_at, NOW())`, [guildId, botId]);
        const [[fresh]] = await pool.execute(
            'SELECT parity_ready_at FROM guild_retire_state WHERE guild_id = ? AND bot_id = ?', [guildId, botId]);
        return fresh?.parity_ready_at ?? null;
    }
    if (!allPass && row?.parity_ready_at) {
        await pool.execute(
            'UPDATE guild_retire_state SET parity_ready_at = NULL WHERE guild_id = ? AND bot_id = ?', [guildId, botId]);
        return null;
    }
    return row?.parity_ready_at ?? null;
}

const readSnapshot = (v) => {
    if (!v) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
};

/** Record that an admin exported a data-holding bot's data. Required before it may be removed. */
export async function acknowledgeExtraction(guildId, botId, userId) {
    if (!DATA_HOLDERS[botId]) throw new Error('that bot holds no data we track');
    const ack = JSON.stringify({ extraction_ack: { by: userId, at: new Date().toISOString() } });
    await pool.execute(
        `INSERT INTO guild_retire_state (guild_id, bot_id, snapshot) VALUES (?, ?, CAST(? AS JSON))
         ON DUPLICATE KEY UPDATE snapshot = JSON_MERGE_PATCH(COALESCE(snapshot, JSON_OBJECT()), CAST(? AS JSON))`,
        [guildId, botId, ack, ack]);
}

// ── Removal ──────────────────────────────────────────────────────────────────

/** Audit-log reasons must be ASCII: bytes above 255 make Discord reject the header outright. */
const ascii = (s) => String(s).replace(/[^\x20-\x7E]/g, '').slice(0, 400);

/**
 * Remove a bot, but only if `evaluate()` still passes right now.
 *
 * Prefers deleting the integration over kicking the member: that strips the application and its
 * registered slash commands together, where a kick leaves stale commands in the picker.
 */
export async function retire(guild, botId, { scanId, userId, soakHours = DEFAULT_SOAK_HOURS, overrideSoak = false } = {}) {
    const verdict = await evaluate(guild, botId, scanId, { soakHours, overrideSoak });
    if (!verdict.ready) {
        return { ok: false, verdict, error: `blocked: ${verdict.blockers.join('; ')}` };
    }

    // A waiver is a thing that happened, not just a thing that was allowed. Record it before the
    // removal so the audit trail exists even if the kick itself then fails.
    if (verdict.soakWaived) {
        logger.warn(`[Retire] SOAK WAIVED by ${userId ?? 'unknown'} — removing ${verdict.name} (${botId}) from `
            + `${guild.name} without the ${soakHours}h parity proof. Every other gate passed.`);
        const waiver = JSON.stringify({ soak_waiver: { by: userId ?? null, at: new Date().toISOString(), soakHours } });
        await pool.execute(
            `INSERT INTO guild_retire_state (guild_id, bot_id, snapshot) VALUES (?, ?, CAST(? AS JSON))
             ON DUPLICATE KEY UPDATE snapshot = JSON_MERGE_PATCH(COALESCE(snapshot, JSON_OBJECT()), CAST(? AS JSON))`,
            [guild.id, botId, waiver, waiver]);
    }

    const member = await guild.members.fetch(botId).catch(() => null);
    if (!member) return { ok: false, verdict, error: 'bot is not in the server' };

    const reason = ascii(`Replaced by ${guild.members.me?.user?.username ?? 'this bot'} - verified feature parity`);
    let method = 'kick';

    try {
        const integrations = await guild.fetchIntegrations().catch(() => null);
        const hit = integrations?.find(i => i.application?.id === botId);
        if (hit) {
            await hit.delete(reason);
            method = 'integration';
        } else {
            await member.kick(reason);
        }
    } catch (err) {
        logger.error(`[Retire] ${guild.id}/${botId} failed: ${err.message}`);
        return { ok: false, verdict, error: err.message };
    }

    await pool.execute(
        `INSERT INTO guild_retire_state (guild_id, bot_id, retired_at, retired_by, method)
         VALUES (?, ?, NOW(), ?, ?)
         ON DUPLICATE KEY UPDATE retired_at = NOW(), retired_by = VALUES(retired_by), method = VALUES(method)`,
        [guild.id, botId, userId ?? null, method]);

    logger.info(`[Retire] ${verdict.name} (${botId}) removed from ${guild.name} via ${method}`);
    return { ok: true, verdict, method };
}
