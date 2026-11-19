/*
 * Stream bot dashboard: the pure view-model helpers behind dashboard/routes/stream-bot.js and its views.
 * No database, no Discord client: the theme audit, the guide screenshots (scripts/site-shots/stream-bot-demo.mjs)
 * and tests/stream-bot-pages.test.js build demo pages with the same functions the route uses.
 */
import { EVENT_TYPES, ROLES, eventType, publicEvent, describeEvent } from '../../core/stream-bot/events.js';
import { CONDITION_TYPES, MATCH_MODES, BITS_KINDS, METADATA_OPS } from '../../core/stream-bot/conditions.js';
import { ACTION_TYPES, TARGET_LABEL, IF_CHECKS, actionType, isClientAction, childLists } from '../../core/stream-bot/actions.js';
import { STREAM_VARS } from '../../core/stream-bot/render.js';
import { STREAM_BOT_SCOPES, TWITCH_FEATURES } from '../../core/stream-bot/scopes.js';

const SNOWFLAKE = /^\d{17,20}$/;

export const PLATFORM_LABEL = Object.freeze({
    twitch: 'Twitch', kick: 'Kick', streamelements: 'StreamElements', streamlabs: 'Streamlabs', kofi: 'Ko-fi',
    bmac: 'Buy Me a Coffee', throne: 'Throne', fourthwall: 'Fourthwall', studio: 'CertiFried Studio', bot: 'Stream bot', test: 'Test',
});

/** Servers where the user has Manage Server (permission bit 0x20) or is the owner, from the OAuth session. */
export function managedGuilds(user) {
    const out = [];
    for (const g of Array.isArray(user?.guilds) ? user.guilds : []) {
        if (!g || !SNOWFLAKE.test(String(g.id))) continue;
        let manage = g.owner === true;
        if (!manage) {
            try { manage = (BigInt(String(g.permissions ?? '0')) & 0x20n) === 0x20n; } catch { manage = false; }
        }
        if (manage) out.push({ id: String(g.id), name: String(g.name || 'Server').slice(0, 100), icon: g.icon || null });
    }
    return out;
}

/** An event as the pages show it (no raw payload). */
export function eventView(e) {
    const pub = publicEvent(e, e.id);
    return {
        id: pub.id, platform: pub.platform, platformLabel: PLATFORM_LABEL[pub.platform] || pub.platform,
        type: pub.type, typeLabel: eventType(pub.type)?.label || pub.type, text: describeEvent(pub),
        occurredAt: pub.occurredAt, test: pub.test,
    };
}

export function catalog(online = { studio: false, overlay: false }) {
    return {
        events: EVENT_TYPES.map((t) => ({ type: t.type, label: t.label, group: t.group, platforms: t.platforms, fields: t.fields })),
        conditions: CONDITION_TYPES,
        matchModes: MATCH_MODES,
        actions: ACTION_TYPES,
        roles: ROLES,
        templateVars: STREAM_VARS,
        targetLabels: TARGET_LABEL,
        devicesOnline: { studio: !!online.studio, overlay: !!online.overlay },
        bitsKinds: BITS_KINDS, metadataOps: METADATA_OPS, ifChecks: IF_CHECKS,
    };
}

/** The labels an automation's client actions carry when nothing of that kind is connected. */
export function needsLabels(actions, online) {
    const out = new Set();
    (function walk(list) {
        for (const s of list || []) {
            const def = actionType(s?.type);
            if (def && isClientAction(s.type) && !online[def.target]) out.add(TARGET_LABEL[def.target]);
            for (const inner of childLists(s)) walk(inner);
        }
    })(actions);
    return [...out];
}

export function guildIdsIn(actions, out = new Set()) {
    for (const s of actions || []) {
        if (s?.type === 'discord.post' && SNOWFLAKE.test(String(s.guildId || ''))) out.add(String(s.guildId));
        for (const inner of childLists(s)) guildIdsIn(inner, out);
    }
    return out;
}

export function automationSummary(a, online) {
    const def = eventType(a.trigger_type);
    return {
        id: a.id, name: a.name, enabled: a.enabled, trigger: a.trigger_type, triggerLabel: def?.label || a.trigger_type,
        platforms: (a.trigger_config?.platforms || []).map((p) => PLATFORM_LABEL[p] || p),
        match: a.trigger_type === 'chat' && a.trigger_config?.match?.text ? a.trigger_config.match : null,
        actionsCount: (a.actions || []).length, conditionsCount: (a.conditions || []).length,
        lastRunAt: a.last_run_at ? new Date(a.last_run_at).toISOString() : null, needs: needsLabels(a.actions, online),
    };
}

export function runView(r) {
    const ms = r.finishedAt && r.startedAt ? new Date(r.finishedAt) - new Date(r.startedAt) : null;
    return {
        id: r.id, automationId: r.automationId, automationName: r.automationName || 'Deleted automation', source: r.source, status: r.status,
        skipReason: r.skipReason, dryRun: r.dryRun, depth: r.depth, parentRunId: r.parentRunId, eventId: r.eventId, error: r.error,
        startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null, finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
        ms, stepsCount: (r.steps || []).length, checks: r.checks || [], steps: r.steps || [],
        eventText: r.input ? describeEvent(r.input) : null, eventPlatform: r.input?.platform ? (PLATFORM_LABEL[r.input.platform] || r.input.platform) : null, eventTest: !!r.input?.test,
    };
}

export function dispatchView(d) {
    return {
        id: d.id, actionType: d.actionType, label: actionType(d.actionType)?.label || d.actionType, target: d.target, status: d.status,
        attempts: d.attempts, deviceId: d.deviceId, error: d.error, createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
        sentAt: d.sentAt ? new Date(d.sentAt).toISOString() : null, ackedAt: d.ackedAt ? new Date(d.ackedAt).toISOString() : null,
        expiresAt: d.expiresAt ? new Date(d.expiresAt).toISOString() : null,
    };
}

export function deviceView(d, onlineIds) {
    return {
        id: d.id, kind: d.kind, name: d.name, tokenHint: d.tokenHint, capabilities: d.capabilities || [], clientInfo: d.clientInfo || null,
        createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null, lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null,
        revoked: !!d.revokedAt, online: onlineIds.has(d.id),
    };
}

/** What an online CertiFried Studio reported (Devices page), or null: app version and the OBS connection. */
export function studioView(conn) {
    if (!conn || conn.kind !== 'studio') return null;
    const obs = conn.state?.obs || null;
    const version = /^certifried-studio\s+(\S+)/.exec(String(conn.client || ''))?.[1] || null;
    return {
        appVersion: version,
        reported: !!conn.state,
        obs: obs ? { connected: !!obs.connected, version: obs.version || null, currentScene: obs.currentScene || null, scenes: (obs.scenes || []).length } : null,
        sounds: (conn.state?.sounds || []).length,
    };
}

/** A library sound for the Sounds page and API (no file path). */
export function soundView(s) {
    return { id: s.id, name: s.name, size: Number(s.size) || 0, mime: s.mime, sha256: s.sha256, uploadedAt: s.uploadedAt || null };
}

/** JSON for a page <script>: written raw, every "<" escaped so text can never close the tag. */
export const pageJson = (v) => JSON.stringify(v ?? null).replace(/</g, '\\u003c');

export const TIP_LABEL = Object.freeze({ streamelements: 'StreamElements', streamlabs: 'Streamlabs', kofi: 'Ko-fi', fourthwall: 'Fourthwall', throne: 'Throne', bmac: 'Buy Me a Coffee' });

export function tipSourceView(s, guildNames) {
    let refLabel = '';
    if (s.source === 'kofi' || s.source === 'fourthwall') refLabel = guildNames.get(String(s.ref)) || `Server ${s.ref}`;
    else if (s.source === 'throne') refLabel = `throne.com/${s.ref}`;
    else if (s.source === 'bmac') refLabel = 'Your linked account';
    else refLabel = s.has_secret ? 'Token saved' : 'No token';
    return {
        id: s.id, source: s.source, label: TIP_LABEL[s.source] || s.source, refLabel, enabled: s.enabled, status: s.status,
        lastError: s.last_error || null, lastEventAt: s.last_event_at ? new Date(s.last_event_at).toISOString() : null,
    };
}

// ── messages the OAuth flows send back to the Connections page ──────────────────────────────

export const CONNECTION_MESSAGES = Object.freeze({
    ok: {
        twitch_grant: 'Twitch is connected. The Stream bot grant is saved and your channel is linked.',
        twitch_grant_removed: 'The Stream bot grant was removed and revoked at Twitch. Your linked channels stay linked.',
        linked_twitch: 'Your Twitch channel is linked.',
        linked_kick: 'Your Kick channel is linked.',
        unlinked: 'The channel was unlinked.',
        tip_added: 'The tip source was added.',
    },
    warn: {
        channel_taken: 'The grant is saved, but that Twitch channel is linked to another CertiFried account, so it was not linked here.',
    },
    error: {
        twitch_declined: 'Twitch was not connected: the permission screen was cancelled.',
        twitch_state: 'The Twitch sign-in expired or was opened in another tab. Start again.',
        twitch_scopes: 'Twitch returned permissions CertiFried does not ask for, so the grant was not saved. Start again.',
        twitch_failed: 'Twitch could not be connected. Try again in a minute.',
        unknown_platform: 'That platform cannot be linked here.',
        platform_coming_soon: 'That platform cannot be linked yet.',
        oauth_denied: 'The sign-in was cancelled.',
        oauth_state: 'The sign-in expired or was opened in another tab. Start again.',
        no_channel_id: 'That sign-in did not return a channel to link.',
        channel_taken: 'That channel is linked to another CertiFried account.',
        connect_failed: 'The channel could not be linked. Try again in a minute.',
    },
});

export function connectionNotice(query) {
    for (const tone of ['error', 'warn', 'ok']) {
        const code = typeof query?.[tone] === 'string' ? query[tone] : null;
        if (code && Object.prototype.hasOwnProperty.call(CONNECTION_MESSAGES[tone], code)) return { tone, text: CONNECTION_MESSAGES[tone][code] };
    }
    return null;
}

/** Scopes the stream actions use (2026-11-19), with what they do. */
export const ACTION_SCOPES = Object.freeze({
    'channel:manage:broadcast': 'Change the stream title and category',
    'channel:manage:raids': 'Start a raid',
    'channel:edit:commercial': 'Run an ad',
    'clips:edit': 'Create a clip',
    'moderator:manage:announcements': 'Chat announcements',
    'moderator:manage:chat_messages': 'Clear chat and delete messages',
    'moderator:manage:shoutouts': 'Shoutouts',
});

/** Scopes nothing uses yet, with what they will do. */
export const LATER_SCOPES = Object.freeze({
    'channel:manage:redemptions': 'Marking redemptions done or refunding them',
});

/** What each Stream bot grant scope enables (scopes.js TWITCH_FEATURES); the Phase 4 manage scopes are marked "later". */
export function scopeRows() {
    return STREAM_BOT_SCOPES.map((scope) => {
        if (LATER_SCOPES[scope]) return { scope, enables: LATER_SCOPES[scope], later: true };
        if (ACTION_SCOPES[scope]) return { scope, enables: ACTION_SCOPES[scope], later: false };
        const feats = TWITCH_FEATURES.filter((f) => !f.later && (f.need || []).some((alt) => alt.some((s) => s === scope || s.replace(':read:', ':manage:') === scope)));
        let enables = feats.map((f) => f.label).join(', ');
        if (scope === 'channel:manage:polls' || scope === 'channel:manage:predictions') enables += scope.endsWith('polls') ? ', and starting and ending polls' : ', and starting and ending predictions';
        return { scope, enables: enables || 'Stream events', later: false };
    });
}
