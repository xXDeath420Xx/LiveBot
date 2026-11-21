/*
 * Stream bot control: named action queues (W2.4, Streamer.bot "Action Queues", Firebot "Effect Queues").
 *
 * An automation joins a queue through its trigger config: trigger_config.queue = { name, blocking }. In a blocking queue
 * runs go one at a time, in the order their events came in (two voice commands back to back wait for each other). A
 * non-blocking queue runs at once but can still be paused or cleared. Automations without a queue run as before.
 * State is in memory (a restart empties the queues, as Streamer.bot's do).
 *
 *   createQueues({ now?, maxPending? })
 *     gate(profile, automation, start)   the engine's run gate (engine.setRunGate): returns start()'s promise, later when queued
 *     pause(pid, name) / resume(pid, name) / clear(pid, name) / pending(pid, name?) / status(pid)
 *     actions()                           queue.pause, queue.resume, queue.clear
 *     vars                                {queue.pending} for registerTemplateVars
 *
 * Tested in tests/stream-bot-control.test.js.
 */

export const QUEUE_NAME = /^[\w .-]{1,40}$/;
export const QUEUE_LIMITS = Object.freeze({ maxPending: 100 });
const f = (name, kind, label, extra = {}) => ({ name, kind, label, ...extra });

/** trigger_config.queue from a save → { name, blocking } or null; errors are pushed through err(). */
export function validateQueue(q, err = () => {}) {
    if (!q || typeof q !== 'object') return null;
    const name = String(q.name ?? '').trim().slice(0, 40);
    if (!name) return null;
    if (!QUEUE_NAME.test(name)) { err('Queue: the name may use letters, numbers, spaces, _ . or -, up to 40 characters.'); return null; }
    return { name, blocking: q.blocking !== false };
}

export function createQueues({ maxPending = QUEUE_LIMITS.maxPending, logger = null } = {}) {
    const queues = new Map();   // 'pid:name' -> { name, blocking, running, paused, waiting: [{ start, resolve, reject }] }
    const key = (pid, name) => `${Number(pid)}:${String(name).toLowerCase()}`;
    const get = (pid, name, blocking = true) => {
        const k = key(pid, name);
        if (!queues.has(k)) queues.set(k, { name, blocking, running: 0, paused: false, waiting: [] });
        const q = queues.get(k);
        q.blocking = blocking;
        return q;
    };

    function pump(q) {
        while (!q.paused && q.waiting.length && (!q.blocking || q.running === 0)) {
            const job = q.waiting.shift();
            q.running++;
            Promise.resolve().then(job.start).then(job.resolve, job.reject).finally(() => { q.running--; pump(q); });
        }
    }

    function gate(profile, automation, start) {
        const cfg = automation?.trigger_config?.queue;
        if (!cfg?.name) return start();
        const q = get(profile.id, cfg.name, cfg.blocking !== false);
        if (q.waiting.length >= maxPending) {
            try { logger?.warn?.(`[StreamBotQueues] queue ${q.name} is full; run of automation ${automation.id} dropped`); } catch { /* ignore */ }
            return Promise.resolve({ runId: null, status: 'skipped', reason: `queue ${q.name} is full (${maxPending} waiting)` });
        }
        return new Promise((resolve, reject) => { q.waiting.push({ start, resolve, reject }); pump(q); });
    }

    const find = (pid, name) => queues.get(key(pid, name)) || null;
    function pause(pid, name) { const q = get(pid, name); q.paused = true; return q; }
    function resume(pid, name) { const q = get(pid, name); q.paused = false; pump(q); return q; }
    function clear(pid, name) {
        const q = find(pid, name);
        if (!q) return 0;
        const n = q.waiting.length;
        for (const job of q.waiting.splice(0)) job.resolve({ runId: null, status: 'skipped', reason: `queue ${q.name} was cleared` });
        return n;
    }
    function pending(pid, name = null) {
        if (name) return find(pid, name)?.waiting.length || 0;
        let n = 0;
        for (const [k, q] of queues) if (k.startsWith(`${Number(pid)}:`)) n += q.waiting.length;
        return n;
    }
    function status(pid) {
        return [...queues.entries()].filter(([k]) => k.startsWith(`${Number(pid)}:`))
            .map(([, q]) => ({ name: q.name, blocking: q.blocking, paused: q.paused, running: q.running, waiting: q.waiting.length }));
    }

    const nameField = f('queue', 'text', 'Queue name (the one set under "When" on the automations)');
    const validateName = (s, out, err) => { out.queue = String(s.queue ?? '').trim().slice(0, 40); if (!QUEUE_NAME.test(out.queue)) err('enter the queue name.'); };
    function actions() {
        return [
            { type: 'queue.pause', label: 'Pause a queue', target: 'server', group: 'Flow', fields: [nameField], validate: validateName,
                async execute(step, ctx) {
                    if (ctx.dryRun) return { status: 'dry', detail: `would pause ${step.queue}` };
                    pause(ctx.profile.id, step.queue);
                    return { status: 'ok', detail: `${step.queue} paused; ${pending(ctx.profile.id, step.queue)} waiting` };
                } },
            { type: 'queue.resume', label: 'Resume a queue', target: 'server', group: 'Flow', fields: [nameField], validate: validateName,
                async execute(step, ctx) {
                    if (ctx.dryRun) return { status: 'dry', detail: `would resume ${step.queue}` };
                    resume(ctx.profile.id, step.queue);
                    return { status: 'ok', detail: `${step.queue} running again` };
                } },
            { type: 'queue.clear', label: 'Clear a queue', target: 'server', group: 'Flow', fields: [nameField], validate: validateName,
                async execute(step, ctx) {
                    if (ctx.dryRun) return { status: 'dry', detail: `would drop the ${pending(ctx.profile.id, step.queue)} runs waiting in ${step.queue}` };
                    const n = clear(ctx.profile.id, step.queue);
                    return { status: 'ok', detail: `${n} waiting run${n === 1 ? '' : 's'} dropped from ${step.queue}` };
                } },
        ];
    }

    const vars = {
        names: ['queue.pending'],
        vars: [{ token: '{queue.pending}', description: 'Runs waiting in your action queues' }],
        values: ({ profileId, template }) => (/\{queue\.pending\}/i.test(template) ? { 'queue.pending': String(pending(profileId)) } : {}),
    };

    return { gate, pause, resume, clear, pending, status, actions, vars };
}

export default { createQueues, validateQueue, QUEUE_NAME, QUEUE_LIMITS };
