/*
 * Stream bot: the automation engine (design §2.3). Runs every enabled automation whose trigger matches an
 * event, checks its conditions, runs its steps in order and logs the run.
 *
 *   createEngine({ store, render, io, limiter?, now?, sleep?, rng?, logger?, limits? })
 *     io.sendChat({ profileId, platform, channelId, login, text })      → { ok, error? }
 *     io.postDiscord({ ownerId, guildId, channelId, text })              → { ok, error? }
 *     io.postWebhook(url, body, { allowHosts })                          → { status }  (throws WebhookError)
 *     io.dispatch({ profileId, runId, target, capability, actionType, params, queueSeconds }) → { id, status: 'sent'|'queued', devices }
 *     io.channelsFor(profileId)                                          → [{ platform, platform_user_id, login }]
 *     io.streamAction(step, { profile, ev, render, dryRun, channels })    → { status, detail, vars? }   (optional; stream-actions.js)
 *     io.streamInfo(profileId, ev)                                       → { live, title, category, viewers, startedAt } | null  (optional)
 *
 * Each run has its own values (`vars`): arguments set by "Set an argument" ({args.name}) and outputs of earlier steps
 * ({clip.url}, {poll.id} ...). A child run (automation.run) starts with a copy of its parent's. Steps run inside
 * counters.js runContext, so a value written by a run started from a "Counter changed" event carries the depth on.
 *
 *   engine.handleEvent(profile, ev, eventId)          every matching automation; resolves when all finished
 *   engine.runAutomation(profile, automation, ev, o)  one automation; o = { source, eventId, parentRunId, depth, chain, test, dryRun,
 *                                                     skipTrigger, manual }  manual (CertiFried Studio's run button or hotkey): no
 *                                                     trigger match, no conditions, cooldowns or rate limits (the busy limits still apply)
 *
 * Loop protection: automation.run chains at most MAX_DEPTH deep and never repeat an automation in one chain;
 * at most RUNS_PER_MINUTE runs per profile per minute and MAX_CONCURRENT at once (beyond that the run is
 * logged as skipped: busy). Steps never throw out of the engine: a failed step is logged and the run goes on.
 *
 * Tested in tests/stream-bot-engine.test.js (throwaway tables, fake io).
 */
import { triggerMatches, checkConditions, createLimiter, loadConditionData } from './conditions.js';
import { actionType, isClientAction, isStreamAction, clientParams, LIMITS as ACTION_LIMITS, TARGET_LABEL } from './actions.js';
import { runContext } from './counters.js';
import { publicEvent } from './events.js';

export const ENGINE_LIMITS = Object.freeze({ maxDepth: 5, runsPerMinute: 60, maxConcurrent: 20, runWallMs: 15 * 60 * 1000 });

export function createEngine({
    store, render, io, limiter = createLimiter(), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    rng = Math.random, logger = null, limits = {},
} = {}) {
    const L = { ...ENGINE_LIMITS, ...limits };
    const recent = new Map();   // profileId -> ms[] of runs started in the last minute
    const active = new Map();   // profileId -> runs in flight
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBot] ${msg}`, meta); } catch { /* never let logging break a run */ } };

    function admit(profileId) {
        const t = now();
        const list = (recent.get(profileId) || []).filter((x) => t - x < 60_000);
        if (list.length >= L.runsPerMinute) { recent.set(profileId, list); return 'busy: more than ' + L.runsPerMinute + ' runs in a minute'; }
        if ((active.get(profileId) || 0) >= L.maxConcurrent) return 'busy: ' + L.maxConcurrent + ' runs already in progress';
        list.push(t);
        recent.set(profileId, list);
        active.set(profileId, (active.get(profileId) || 0) + 1);
        return null;
    }
    const release = (profileId) => active.set(profileId, Math.max(0, (active.get(profileId) || 1) - 1));

    async function channelName(profileId, platform) {
        try {
            const list = await io.channelsFor(profileId);
            return list.find((c) => c.platform === platform)?.login || list[0]?.login || '';
        } catch { return ''; }
    }

    /** Run one step. Returns { status, detail, dispatchId? }. */
    async function runStep(step, ctx) {
        const def = actionType(step.type);
        if (!def) return { status: 'failed', detail: `unknown action ${step.type}` };
        const rctx = { ev: ctx.ev, profileId: ctx.profile.id, automationId: ctx.automation.id, channelName: ctx.channelName, vars: ctx.vars,
            stream: io.streamInfo ? () => io.streamInfo(ctx.profile.id, ctx.ev) : null };
        const render1 = (t) => render(t, rctx);

        if (isClientAction(step.type)) {
            const params = await clientParams(step, render1);
            if (ctx.dryRun) return { status: 'dry', detail: `would send to ${def.target === 'studio' ? 'CertiFried Studio' : 'an overlay'}: ${JSON.stringify(params).slice(0, 200)}` };
            const r = await io.dispatch({ profileId: ctx.profile.id, runId: ctx.runId, target: def.target, capability: def.capability || null,
                actionType: step.type, params, queueSeconds: step.queueSeconds ?? ACTION_LIMITS.queueDefault });
            if (r.status === 'sent') return { status: 'sent', detail: `sent to ${r.devices || 1} device${r.devices === 1 ? '' : 's'}`, dispatchId: r.id };
            // Phase 5: a cloud light is carried out on the server at once (core/stream-bot/devices/service.js).
            if (r.status === 'done') return { status: 'ok', detail: r.detail || 'done', ...(r.id ? { dispatchId: r.id } : {}) };
            if (r.status === 'failed') return { status: 'failed', detail: r.detail || 'failed', ...(r.id ? { dispatchId: r.id } : {}) };
            if (r.status === 'queued') return { status: 'queued', detail: `${TARGET_LABEL[def.target]}: queued for ${step.queueSeconds ?? ACTION_LIMITS.queueDefault} s`, dispatchId: r.id };
            return { status: 'skipped', detail: `${TARGET_LABEL[def.target]}: nothing connected`, dispatchId: r.id || null };
        }

        if (isStreamAction(step.type)) {
            if (!io.streamAction) return { status: 'failed', detail: 'stream actions are not available on this server yet' };
            let channels = [];
            try { channels = await io.channelsFor(ctx.profile.id); } catch { /* none */ }
            const r = await io.streamAction(step, { profile: ctx.profile, ev: ctx.ev, render: render1, dryRun: ctx.dryRun, channels });
            if (r?.vars) Object.assign(ctx.vars, r.vars);
            return r || { status: 'failed', detail: 'no result' };
        }

        switch (step.type) {
            case 'args.set': {
                const value = (await render1(step.value)).slice(0, 1000);
                ctx.vars[`args.${step.name}`] = value;
                return { status: ctx.dryRun ? 'dry' : 'ok', detail: `{args.${step.name}} = ${value.slice(0, 100)}` };
            }
            case 'chat.send': {
                const text = (await render1(step.text)).trim();
                if (!text) return { status: 'skipped', detail: 'the message came out empty' };
                const channels = await io.channelsFor(ctx.profile.id);
                let targets;
                if (step.platform === 'all') targets = channels.filter((c) => c.platform === 'twitch' || c.platform === 'kick' || c.platform === 'youtube');
                else {
                    const p = step.platform === 'event' || !step.platform ? ctx.ev.platform : step.platform;
                    const own = p === ctx.ev.platform && ctx.ev.channelId ? channels.filter((c) => c.platform === p && String(c.platform_user_id) === String(ctx.ev.channelId)) : [];
                    targets = own.length ? own : channels.filter((c) => c.platform === p).slice(0, 1);
                }
                if (!targets.length) return { status: 'skipped', detail: step.platform === 'event' ? `no chat for ${ctx.ev.platform} events (use Twitch, Kick or All)` : 'no linked channel on that platform' };
                if (ctx.dryRun) return { status: 'dry', detail: `would say in ${targets.map((c) => `${c.platform}/${c.login}`).join(', ')}: ${text.slice(0, 300)}` };
                const results = [];
                let sent = 0;
                for (const c of targets) {
                    const r = await io.sendChat({ profileId: ctx.profile.id, platform: c.platform, channelId: c.platform_user_id, login: c.login, text });
                    results.push(`${c.platform}/${c.login}: ${r.ok ? 'sent' : r.error || 'failed'}`);
                    if (r.ok) sent++;
                    // "All": a YouTube channel that is not live has no chat to post in, which is not a failure (H-741).
                    else if (!(step.platform === 'all' && r.notLive)) return { status: 'failed', detail: results.join('; ') };
                }
                if (!sent) return { status: 'skipped', detail: results.join('; ') };
                return { status: 'ok', detail: `${results.join('; ')}: ${text.slice(0, 300)}` };
            }
            case 'discord.post': {
                const text = (await render1(step.text)).trim();
                if (!text) return { status: 'skipped', detail: 'the message came out empty' };
                if (ctx.dryRun) return { status: 'dry', detail: `would post in channel ${step.channelId}: ${text.slice(0, 300)}` };
                const r = await io.postDiscord({ ownerId: ctx.profile.ownerDiscordId, guildId: step.guildId, channelId: step.channelId, text });
                return r.ok ? { status: 'ok', detail: `posted: ${text.slice(0, 300)}` } : { status: 'failed', detail: r.error || 'could not post' };
            }
            case 'delay': {
                const ms = Math.round(Number(step.seconds) * 1000);
                if (ctx.delayUsed + ms > ACTION_LIMITS.delayTotal * 1000) return { status: 'failed', detail: `over ${ACTION_LIMITS.delayTotal} s of waiting in one run` };
                ctx.delayUsed += ms;
                if (ctx.dryRun) return { status: 'dry', detail: `would wait ${step.seconds} s` };
                await sleep(ms);
                return { status: 'ok', detail: `waited ${step.seconds} s` };
            }
            case 'variable.set':
            case 'variable.increment': {
                const owner = step.scope === 'user' ? (ctx.ev.user?.id ? `${ctx.ev.platform}:${ctx.ev.user.id}` : null) : 'server';
                if (!owner) return { status: 'skipped', detail: 'this event has no viewer to store a value for' };
                if (step.type === 'variable.set') {
                    const value = (await render1(step.value)).slice(0, 1000);
                    if (ctx.dryRun) return { status: 'dry', detail: `would set ${step.key} = ${value.slice(0, 100)}` };
                    const r = await store.variableStore.set(ctx.profile.id, owner, step.key, value, step.scope === 'user' ? 100 : 1000);
                    return r.full ? { status: 'failed', detail: 'storage full' } : { status: 'ok', detail: `${step.key} = ${value.slice(0, 100)}` };
                }
                if (ctx.dryRun) return { status: 'dry', detail: `would add ${step.by} to ${step.key}` };
                const r = await store.variableStore.incr(ctx.profile.id, owner, step.key, step.by ?? 1, step.scope === 'user' ? 100 : 1000);
                return r.full ? { status: 'failed', detail: 'storage full' } : { status: 'ok', detail: `${step.key} is now ${r.value}` };
            }
            case 'webhook.post': {
                const body = step.body ? await render1(step.body) : JSON.stringify({ event: publicEvent(ctx.ev, ctx.eventId), automation: { id: ctx.automation.id, name: ctx.automation.name } });
                if (ctx.dryRun) return { status: 'dry', detail: `would POST ${Buffer.byteLength(body)} bytes to ${step.url}` };
                try {
                    const r = await io.postWebhook(step.url, body, { allowHosts: ctx.profile.webhookAllowHosts || [] });
                    return { status: 'ok', detail: `HTTP ${r.status}` };
                } catch (err) {
                    return { status: 'failed', detail: err.message || 'webhook failed' };
                }
            }
            case 'automation.run': {
                const id = Number(step.automationId);
                if (ctx.chain.includes(id)) return { status: 'failed', detail: `loop stopped: automation ${id} is already running in this chain` };
                if (ctx.depth + 1 >= L.maxDepth) return { status: 'failed', detail: `loop stopped: more than ${L.maxDepth} automations deep` };
                const target = await store.getAutomation(ctx.profile.id, id);
                if (!target) return { status: 'failed', detail: 'that automation no longer exists' };
                if (!target.enabled) return { status: 'skipped', detail: `${target.name} is turned off` };
                const child = await runAutomation(ctx.profile, target, ctx.ev, {
                    source: 'automation', eventId: ctx.eventId, parentRunId: ctx.runId, depth: ctx.depth + 1, chain: ctx.chain,
                    test: ctx.test, dryRun: ctx.dryRun, skipTrigger: true, vars: ctx.vars,
                });
                return { status: child.status === 'failed' ? 'failed' : 'ok', detail: `ran ${target.name} (run ${child.runId}: ${child.status})`, childRunId: child.runId };
            }
            default:
                if (typeof def.execute === 'function') return def.execute(step, { ...ctx, render: render1, io, store });   // registerActionType()
                return { status: 'failed', detail: `no executor for ${step.type}` };
        }
    }

    async function runSteps(list, ctx, out, path = '') {
        for (let i = 0; i < list.length; i++) {
            const step = list[i];
            const at = path ? `${path}.${i + 1}` : String(i + 1);
            if (now() > ctx.deadline) { out.push({ at, type: step.type, status: 'failed', detail: 'run took too long; stopped', ms: 0 }); return; }
            const started = now();
            if (step.type === 'random') {
                const branches = step.branches || [];
                const total = branches.reduce((s, b) => s + (Number(b.weight) || 1), 0);
                let roll = rng() * total;
                let pick = branches.length - 1;
                for (let b = 0; b < branches.length; b++) { roll -= Number(branches[b].weight) || 1; if (roll < 0) { pick = b; break; } }
                out.push({ at, type: 'random', status: 'ok', detail: `picked choice ${pick + 1} of ${branches.length}`, ms: 0 });
                await runSteps(branches[pick]?.actions || [], ctx, out, `${at}.${pick + 1}`);
                continue;
            }
            if (step.type === 'if') {
                // Event details plus this run's arguments (metadata path args.<name>).
                const args = {};
                for (const [k, v] of Object.entries(ctx.vars || {})) if (k.startsWith('args.')) args[k.slice(5)] = v;
                const evc = { ...ctx.ev, metadata: { ...(ctx.ev?.metadata || {}), args } };
                const r = checkConditions(step.check ? [step.check] : [], evc, {});
                out.push({ at, type: 'if', status: 'ok', detail: `${r.results[0]?.detail || 'no check'}: ${r.ok ? 'then' : 'otherwise'}`, ms: 0 });
                await runSteps((r.ok ? step.then : step.else) || [], ctx, out, `${at}.${r.ok ? 1 : 2}`);
                continue;
            }
            let r;
            try { r = await runStep(step, ctx); } catch (err) {
                r = { status: 'failed', detail: err?.message ? String(err.message).slice(0, 300) : 'error' };
                log('warn', 'step threw', { type: step.type, error: err?.message });
            }
            out.push({ at, type: step.type, status: r.status, detail: r.detail ? String(r.detail).slice(0, 500) : '', ms: now() - started,
                ...(r.dispatchId ? { dispatchId: r.dispatchId } : {}), ...(r.childRunId ? { childRunId: r.childRunId } : {}) });
        }
    }

    const overall = (steps) => {
        const real = steps.filter((s) => s.type !== 'random' && s.type !== 'if');
        if (!real.length) return 'ok';
        const failed = real.filter((s) => s.status === 'failed').length;
        if (!failed) return 'ok';
        return failed === real.length ? 'failed' : 'partial';
    };

    async function runAutomation(profile, automation, ev, o = {}) {
        const { source = 'event', eventId = null, parentRunId = null, depth = 0, chain = [], test = false, dryRun = false, skipTrigger = false, manual = false, vars = null } = o;
        const base = { automationId: automation.id, automationName: automation.name, eventId, source, parentRunId, depth, dryRun, input: publicEvent(ev, eventId), startedAt: new Date(now()) };
        if (!skipTrigger && !manual && !triggerMatches(automation, ev)) return { runId: null, status: 'no_match' };

        const busy = depth === 0 ? admit(profile.id) : null;
        if (busy) {
            const runId = await store.createRun(profile.id, { ...base, status: 'skipped', skipReason: busy });
            await store.finishRun(runId, { status: 'skipped', steps: [] });
            return { runId, status: 'skipped' };
        }
        let runId = null;
        try {
            // Registered conditions (viewer points, watch time, messages) read their data first (conditions.js loadConditionData).
            const loaded = manual ? {} : await loadConditionData(automation.conditions, ev, { profileId: profile.id });
            const check = manual ? { ok: true, results: [] } : checkConditions(automation.conditions, ev, { limiter, automationId: automation.id, test, loaded });
            if (!check.ok) {
                runId = await store.createRun(profile.id, { ...base, status: 'skipped', skipReason: `${check.failed.type}: ${check.failed.detail}`, checks: check.results });
                await store.finishRun(runId, { status: 'skipped', steps: [], checks: check.results });
                return { runId, status: 'skipped' };
            }
            if (!test && !manual) limiter.record(automation.id, automation.conditions, ev);
            runId = await store.createRun(profile.id, { ...base, status: 'running', checks: check.results });
            await store.touchAutomation(automation.id).catch(() => {});
            const ctx = {
                profile, automation, ev, eventId, runId, depth, chain: [...chain, automation.id], test, dryRun,
                delayUsed: 0, deadline: now() + L.runWallMs, channelName: await channelName(profile.id, ev.platform), vars: { ...(vars || {}) },
            };
            const steps = [];
            const eventDepth = ev?.type === 'variable.changed' ? Number(ev.metadata?.depth) || 1 : 0;
            await runContext.run({ profileId: profile.id, eventDepth }, () => runSteps(automation.actions || [], ctx, steps));
            const status = overall(steps);
            await store.finishRun(runId, { status, steps });
            return { runId, status, steps };
        } catch (err) {
            log('error', 'run failed', { automationId: automation.id, error: err?.message });
            if (runId) await store.finishRun(runId, { status: 'failed', steps: [], error: err?.message || 'error' }).catch(() => {});
            return { runId, status: 'failed', error: err?.message };
        } finally {
            if (!busy && depth === 0) release(profile.id);
        }
    }

    async function handleEvent(profile, ev, eventId = null) {
        let list;
        try { list = await store.enabledAutomationsFor(profile.id, ev.type); } catch (err) {
            log('error', 'could not load automations', { profileId: profile.id, error: err?.message });
            return [];
        }
        const matching = list.filter((a) => triggerMatches(a, ev));
        return Promise.all(matching.map((a) => runAutomation(profile, a, ev, { source: 'event', eventId })));
    }

    return { handleEvent, runAutomation, limiter, _state: { recent, active } };
}

export default { createEngine, ENGINE_LIMITS };
