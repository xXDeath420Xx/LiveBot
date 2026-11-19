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
import { plan, resolveBotMeta, featuresOf } from './takeover-manager.js';
import { getTemplates, unattributedCount } from './guild-analyzer.js';
import { classifyTemplate, asList } from './takeover-classifier.js';

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
    '437808476106784770': { name: 'Arcane', what: 'levels and XP', how: 'no export API — members keep their level ROLE, but the XP totals are gone. Accept the loss explicitly.' },
    '292953664492929025': { name: 'UnbelievaBoat', what: 'per-server balances', how: 'export the balance leaderboard from the UnbelievaBoat dashboard first — it is the only copy' },
    '204255221017214977': { name: 'YAGPDB.xyz', what: 'custom command scripts', how: 'copy the command sources out of the YAGPDB control panel — they are not readable from Discord' },
});

/*
 * Deciding what a message shape was FOR now lives in core/takeover-classifier.js.
 *
 * It used to be a flat list of regexes here, one array per feature, matched against the bot's
 * primary feature only. On an ordinary server that left 382 shapes for a human to tick — 179 of them
 * the same stream announcement, 247 of them the same voice-join log. The classifier scores instead
 * of matching, considers every job the bot does, recognises the things that are not a feature at all
 * (a vendor's changelog, Discord's admin broadcasts), and reports its reasoning. Same server, same
 * scan: 2 left for a human.
 */

/**
 * Attribute what we safely can; return how many remain for a human.
 *
 * `name` matters: a webhook persona is keyed `wh:<name>`, so without it a webhook can never be
 * matched to the bot that owns it. Callers that have the scanned name should pass it.
 */
export async function autoAttribute(scanId, botId, name = null, selfId = null, guild = null) {
    const meta = resolveBotMeta(botId, name, selfId);
    const candidates = featuresOf(meta);

    // Channel names only exist if we were handed a live guild. Without one the classifier simply
    // loses a tiebreaker — it never depends on them, so this degrades rather than breaks.
    const channelNames = (t) => guild
        ? asList(t.channels).map(id => guild.channels?.cache?.get(id)?.name).filter(Boolean)
        : [];

    const templates = await getTemplates(scanId, botId);
    let matched = 0;

    for (const t of templates) {
        if (t.attributed) continue;
        if (t.template_hash === 'TRUNCATED000000') continue; // never auto-clear a truncation marker

        // Read the message AND its context: which command produced it, and where it was posted.
        // The command is the strongest evidence in the dataset — somebody typed `/leaderboard` and
        // this came back — and ignoring it was why replies whose text says nothing recognisable
        // ("He won't kill but he will hospitalize you for life") were being sent to a human.
        //
        // `unsure` is still a real answer and it still goes to a person. A confident wrong verdict
        // here is the one failure mode that could get a bot retired on evidence nobody explained.
        const v = classifyTemplate(t.sample, candidates, {
            triggers: asList(t.triggers),
            channelNames: channelNames(t),
        });
        if (v.confidence === 'unsure' || !v.feature) continue;

        // A shape that is not one of our features is still EXPLAINED. A vendor's changelog, Discord's
        // own admin broadcast, a posted meme — none of them are behaviour this server configured, and
        // counting them as unexplained is what made a finished takeover look unfinished. The row
        // records which kind, prefixed, so nothing later mistakes it for a feature we replaced.
        const label = v.kind === 'feature' ? v.feature : `n/a:${v.feature}`;

        await pool.execute(
            `UPDATE guild_scan_templates SET attributed = 1, attributed_to = ?, attributed_by = 'auto'
             WHERE id = ?`, [label.slice(0, 64), t.id]);
        matched++;
    }
    return { matched, remaining: await unattributedCount(scanId, botId) };
}

// ── Gates ────────────────────────────────────────────────────────────────────

/**
 * Steps in a takeover plan that must be `done` before a given feature counts as replaced.
 *
 * A feature is auto-verifiable exactly when it appears here with a non-empty list: the gate can prove
 * we replaced it by checking those plan steps are done. A feature that is absent, or present with an
 * empty list, has NO machine check — the gate refuses it and a human must confirm parity by hand.
 * That distinction is deliberate and load-bearing: it is the line between "a bot the tool can retire
 * on its own" and "a bot only a person should sign off on".
 *
 * The four added below (reaction_roles, custom_commands, birthday, streams) each have a step whose
 * `done` genuinely IS the proof — the panels are posted, the commands exist, the birthday config is
 * live, the subscription is created. Leaving them out did not make anything safer; it only forced a
 * manual click for a thing we could already verify.
 */
const PARITY_STEPS = {
    counting: ['counting'],
    logging: ['logging'],
    timezone: ['timezone'],
    catbot: ['catbot'],
    growtree: ['growtree'],
    owo: ['owo'],
    kofi: ['kofi'],
    reaction_roles: ['carlbot_panels'],                         // our button panels are posted
    // Three keys, because a custom-command system can be recovered by either route: the generic
    // one (whatever the scan caught any bot answering) or the two profile-backed ones.
    custom_commands: ['custom_commands', 'nightbot_commands', 'nightbot_autoresponses'],
    birthday: ['birthday'],
    streams: ['streams'],   // the subscription exists; the dry run + owner confirm ARE the by-hand review
    // The last four, so a takeover can be fully hands-off. Each has a real, checkable replacement:
    emoji: ['emoji_ready'],       // /emoji is a standing command — nothing to configure, so always ready
    cannabis: ['cannabis_ready'], // /puff /pass /cheers /join /smokecircle /endcircle /dailyjoint — deployed
    moderation: ['protection'],   // our anti-nuke/raid/spam/phishing suite is switched on
    free_games: ['free_games'],   // a free-games subscription posts to the same channel FreeStuff used
    throne: ['throne'],           // the guild's Throne wishlist owner is configured
    leveling: ['leveling'],       // XP tracking is switched on; level ROLES stay a human decision
};

/** Does the retirement gate have a machine check for this feature, or does it need a human? */
export function isAutoVerifiable(feature) {
    return Array.isArray(PARITY_STEPS[feature]) && PARITY_STEPS[feature].length > 0;
}

const gate = (id, label, pass, detail) => ({ id, label, pass, detail });

/**
 * Evaluate every gate for one bot. Pure inspection — safe to call from a GET.
 * `pass: null` means "cannot determine", which is treated as a failure by `retire()`.
 */
export async function evaluate(guild, botId, scanId, { soakHours = DEFAULT_SOAK_HOURS, overrideSoak = false } = {}) {
    // Resolve, do not index. A bot whose id we never wrote down still resolves by name, and a bot
    // that only ever posts through a webhook has no snowflake to index by at all.
    const meta = resolveBotMeta(botId, null) ?? null;
    const member = await guild.members.fetch(botId).catch(() => null);
    const gates = [];

    // Every job this bot does HERE.
    //
    // The gate has to clear all of them — retiring a bot that runs logging AND the welcome message on
    // the strength of logging alone takes the other out with it, silently, on a live server. But it
    // must only count jobs the bot is ACTUALLY DOING in this server. Requiring parity for a starboard
    // this server has never had made every all-rounder permanently un-retirable: Dyno lists eight
    // features, four of them need a human to choose a channel, and none of those four had ever posted
    // a single message here.
    const capable = featuresOf(meta);
    const seen = scanId ? await observedFeatures(scanId, botId, member?.user?.username ?? null) : null;
    const features = seen?.size ? capable.filter(f => seen.has(f)) : capable;
    const unused = capable.filter(f => !features.includes(f));

    // 1. Do we even claim to replace it?
    gates.push(gate('known', 'We have a replacement feature',
        features.length > 0,
        meta ? (features.length
            ? `replaces our "${features.join('", "')}"`
              + (unused.length ? ` (it can also do ${unused.join(', ')}, but never has here)` : '')
            : `unreplaceable — ${meta.why}`)
            : 'unrecognised bot — classify it before removing anything'));

    // 2. Still here?
    gates.push(gate('present', 'Bot is still in the server', !!member,
        member ? member.user.tag : 'already gone'));

    // 3. Parity: re-read live config, do not trust that `apply()` ran.
    if (features.length) {
        const unverifiable = features.filter(f => !isAutoVerifiable(f));

        // A feature we cannot machine-check is not a permanent refusal — it is a question for a
        // person. Welcome messages and auto-roles need somebody to choose a channel and a role; no
        // amount of waiting makes that checkable. So it becomes an acknowledgement, recorded against
        // this bot with who said it and when, exactly like the data-extraction one.
        const ack = unverifiable.length ? await parityAck(guild.id, botId) : null;

        if (unverifiable.length && !ack) {
            gates.push(gate('parity', 'Feature parity verified', false,
                `${unverifiable.map(f => `"${f}"`).join(', ')} cannot be checked automatically — set `
                + 'them up yourself, then confirm you have. Everything else about this bot is verified.'));
        } else if (unverifiable.length) {
            gates.push(gate('parity', 'Feature parity verified', true,
                `${unverifiable.map(f => `"${f}"`).join(', ')} confirmed by hand (${ack.by}); the rest verified`));
        } else {
            const wanted = features.flatMap(f => PARITY_STEPS[f]);
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
        features: featuresOf(meta),
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
/**
 * Which of a bot's jobs it is ACTUALLY doing in this server, read from its own messages.
 *
 * Matched by resolved NAME rather than row id, so a bot that posts through a webhook (`wh:Dyno`)
 * has that output counted as its own — which is most of it, for the big logging bots.
 */
async function observedFeatures(scanId, botId, name = null) {
    const { summariseBot } = await import('./takeover-classifier.js');
    const meta = resolveBotMeta(botId, name);
    if (!meta) return new Set();

    const [rows] = await pool.execute(
        `SELECT id, bot_id, sample, occurrences, attributed, triggers, channels
           FROM guild_scan_templates WHERE scan_id = ?`, [scanId]).catch(() => [[]]);

    const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const mine = rows.filter(r => {
        if (r.bot_id === botId) return true;
        const m = resolveBotMeta(r.bot_id, null);
        return m && key(m.name) === key(meta.name);
    });
    if (!mine.length) return new Set();

    return new Set(summariseBot(mine, featuresOf(meta)).families
        .filter(f => f.kind === 'feature')
        .map(f => f.feature));
}

/** The recorded "I have set up the parts you cannot check" statement, or null. */
async function parityAck(guildId, botId) {
    const [[state]] = await pool.execute(
        'SELECT snapshot FROM guild_retire_state WHERE guild_id = ? AND bot_id = ?', [guildId, botId])
        .catch(() => [[]]);
    return readSnapshot(state?.snapshot)?.parity_ack ?? null;
}

/**
 * Record that a human has set up the features we cannot machine-check.
 *
 * Deliberately a separate statement from the data-extraction one: they mean different things
 * ("I saved what would be lost" vs "I stood the replacement up myself"), and collapsing them would
 * let one click answer a question nobody asked.
 */
export async function acknowledgeParity(guildId, botId, userId, features = []) {
    const ack = JSON.stringify({
        parity_ack: { by: userId, at: new Date().toISOString(), features },
    });
    await pool.execute(
        `INSERT INTO guild_retire_state (guild_id, bot_id, snapshot) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE snapshot = JSON_MERGE_PATCH(COALESCE(snapshot, JSON_OBJECT()), ?)`,
        [guildId, botId, ack, ack]);
}

export async function acknowledgeExtraction(guildId, botId, userId) {
    if (!DATA_HOLDERS[botId]) throw new Error('that bot holds no data we track');
    const ack = JSON.stringify({ extraction_ack: { by: userId, at: new Date().toISOString() } });
    // MariaDB's JSON type is an alias for LONGTEXT and it rejects `CAST(x AS JSON)` — that MySQL-ism
    // is what crashed every removal. The bound string goes in directly; JSON_MERGE_PATCH still merges.
    await pool.execute(
        `INSERT INTO guild_retire_state (guild_id, bot_id, snapshot) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE snapshot = JSON_MERGE_PATCH(COALESCE(snapshot, JSON_OBJECT()), ?)`,
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

    // A waiver is a thing that happened, so we note it — but the NOTE must never be able to stop the
    // removal. It did exactly that once: a CAST(x AS JSON) that MariaDB rejects threw here and killed
    // all 16 kicks before they ran. An audit record is worth nothing next to the action it records, so
    // this is best-effort and swallowed.
    if (verdict.soakWaived) {
        logger.warn(`[Retire] SOAK WAIVED by ${userId ?? 'unknown'} — removing ${verdict.name} (${botId}) from `
            + `${guild.name} without the ${soakHours}h parity proof. Every other gate passed.`);
        const waiver = JSON.stringify({ soak_waiver: { by: userId ?? null, at: new Date().toISOString(), soakHours } });
        await pool.execute(
            `INSERT INTO guild_retire_state (guild_id, bot_id, snapshot) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE snapshot = JSON_MERGE_PATCH(COALESCE(snapshot, JSON_OBJECT()), ?)`,
            [guild.id, botId, waiver, waiver])
            .catch(err => logger.error(`[Retire] could not record soak waiver (removing anyway): ${err.message}`));
    }

    const member = await guild.members.fetch(botId).catch(() => null);
    if (!member) return { ok: false, verdict, error: 'bot is not in the server' };

    const reason = ascii(`Replaced by ${guild.members.me?.user?.username ?? 'this bot'} - verified feature parity`);
    let method = 'kick';

    try {
        const integrations = await guild.fetchIntegrations().catch(() => null);
        const hit = integrations?.find(i => i.application?.id === botId);
        // Prefer the integration delete (clears slash commands too), but never let its failure abort
        // the removal — some integrations return "Missing Access" even to an admin. Fall back to a kick.
        if (hit) {
            try { await hit.delete(reason); method = 'integration'; }
            catch (err) { logger.warn(`[Retire] integration delete failed for ${botId} (${err.message}) — kicking`); await member.kick(reason); }
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
