/*
 * Stream bot control: chat polls for Kick and YouTube (W2.18; Streamlabs Cloudbot "Polls"). Twitch has native polls
 * (stream.poll); Kick and YouTube have none in their public APIs, so viewers vote in chat with !vote 1, !vote 2 …
 *
 * The poll raises the same events as a Twitch poll (poll.begin, poll.progress at most every 5 s, poll.end) with the same
 * shape ({ title, choices: [{ title, votes }], winner, status, id }), so automations and the poll overlay work everywhere.
 * One vote per viewer (a new vote replaces the old one). One chat poll per profile at a time. State is in memory.
 *
 *   createChatPolls({ raise(profileId, ev), say(profileId, platform, text), now?, setTimer?, clearTimer? })
 *     onChat(profileId, pub)   every chat line the feed publishes (index.js wraps feed.publish)
 *     start(profileId, { title, choices, seconds, platforms }) / end(profileId, status)
 *     actions()                poll.chat, poll.chat_end
 *
 * Tested in tests/stream-bot-control.test.js.
 */
const f = (name, kind, label, extra = {}) => ({ name, kind, label, ...extra });
const lines = (s) => String(s ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const VOTE = /^!vote\s+(\d{1,2})\b/i;
export const POLL_WHERE = Object.freeze({ chat: 'Kick and YouTube chat', kick: 'Kick chat', youtube: 'YouTube chat', all: 'Twitch, Kick and YouTube chat' });

export function createChatPolls({ raise, say = async () => {}, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t), progressMs = 5000 } = {}) {
    const polls = new Map();   // profileId -> poll
    let seq = 0;

    const choicesOf = (p) => p.choices.map((title, i) => ({ title, votes: [...p.votes.values()].filter((v) => v === i).length }));
    function event(p, type, extra = {}) {
        const choices = choicesOf(p);
        return {
            platform: p.platforms.length === 1 ? p.platforms[0] : 'bot', type, channelId: null, user: null, amount: null, currency: null,
            message: p.title, raw: null, occurredAt: new Date(now()), dedupeKey: null, internal: true,
            metadata: { title: p.title, choices, id: p.id, status: extra.status || 'active', chat: true, winner: extra.winner ?? null, platforms: p.platforms },
        };
    }
    function emit(pid, p, type, extra) { try { raise(pid, event(p, type, extra)); } catch { /* best effort */ } }

    async function start(pid, { title, choices, seconds, platforms }) {
        if (polls.has(pid)) return { ok: false, error: 'a chat poll is already running; end it first' };
        const p = { id: `chatpoll-${pid}-${now()}-${++seq}`, title, choices, platforms, votes: new Map(), endsAt: now() + seconds * 1000, lastProgress: 0, dirty: false };
        p.timer = setTimer(() => { end(pid, 'completed').catch(() => {}); }, seconds * 1000);
        p.tick = setInterval(() => { if (p.dirty && now() - p.lastProgress >= progressMs) { p.dirty = false; p.lastProgress = now(); emit(pid, p, 'poll.progress'); } }, Math.max(1000, progressMs));
        p.tick.unref?.();
        polls.set(pid, p);
        emit(pid, p, 'poll.begin');
        const opts = choices.map((c, i) => `${i + 1} ${c}`).join(' | ');
        await say(pid, platforms, `Poll: ${title} Vote with !vote and a number: ${opts}`.slice(0, 480)).catch(() => {});
        return { ok: true, id: p.id };
    }

    async function end(pid, status = 'completed') {
        const p = polls.get(pid);
        if (!p) return { ok: false, error: 'no chat poll is running' };
        polls.delete(pid);
        clearTimer(p.timer);
        clearInterval(p.tick);
        const tally = choicesOf(p);
        const top = tally.reduce((a, b) => (b.votes > a.votes ? b : a), tally[0]);
        const tie = tally.filter((c) => c.votes === top.votes).length > 1;
        const winner = top.votes > 0 && !tie ? top.title : null;
        emit(pid, p, 'poll.end', { status, winner });
        if (status !== 'archived') {
            const total = tally.reduce((n, c) => n + c.votes, 0);
            const line = total ? `Poll closed: ${p.title} ${tally.map((c) => `${c.title} ${c.votes}`).join(', ')}.${winner ? ` ${winner} wins.` : ' It is a tie.'}` : `Poll closed: ${p.title} No votes.`;
            await say(pid, p.platforms, line.slice(0, 480)).catch(() => {});
        }
        return { ok: true, winner, choices: tally };
    }

    function onChat(pid, pub) {
        const p = polls.get(Number(pid));
        if (!p || pub?.type !== 'chat' || !pub.user || pub.test) return false;
        if (!p.platforms.includes(pub.platform)) return false;
        const m = String(pub.message || '').trim().match(VOTE);
        if (!m) return false;
        const n = Number(m[1]) - 1;
        if (n < 0 || n >= p.choices.length) return false;
        const who = `${pub.platform}:${pub.user.id || pub.user.login || pub.user.name}`;
        p.votes.set(who, n);
        p.dirty = true;
        return true;
    }

    function actions() {
        return [
            {
                type: 'poll.chat', label: 'Start a chat poll (Kick and YouTube)', target: 'server', group: 'Polls and predictions', platforms: ['kick', 'youtube', 'twitch'],
                fields: [
                    f('where', 'select', 'Where viewers vote', { options: Object.keys(POLL_WHERE), default: 'chat', optionLabels: POLL_WHERE }),
                    f('title', 'template', 'Question'), f('choices', 'lines', 'Choices, one per line (2 to 10)'),
                    f('duration', 'number', 'Runs for (seconds)', { min: 15, max: 1800, default: 120 }),
                ],
                templates: ['title'], outputs: ['poll.id'],
                validate(s, out, err) {
                    out.where = Object.keys(POLL_WHERE).includes(s.where) ? s.where : 'chat';
                    out.title = String(s.title ?? '').slice(0, 300).trim();
                    const items = lines(s.choices);
                    out.choices = items.slice(0, 10).map((x) => x.slice(0, 60)).join('\n');
                    if (!out.title) err('enter the question.');
                    if (items.length < 2 || items.length > 10) err('enter 2 to 10 choices, one per line.');
                    const n = Number(s.duration ?? 120);
                    if (!Number.isFinite(n) || n < 15 || n > 1800) err('the poll runs 15 to 1800 seconds.');
                    out.duration = Number.isFinite(n) ? Math.min(1800, Math.max(15, Math.round(n))) : 120;
                },
                async execute(step, ctx) {
                    const title = (await ctx.render(step.title)).trim().slice(0, 200);
                    const choices = [];
                    for (const l of lines(step.choices)) { const t = (await ctx.render(l)).trim().slice(0, 60); if (t) choices.push(t); }
                    if (!title || choices.length < 2) return { status: 'skipped', detail: 'a poll needs a question and at least two choices' };
                    const platforms = { chat: ['kick', 'youtube'], kick: ['kick'], youtube: ['youtube'], all: ['twitch', 'kick', 'youtube'] }[step.where] || ['kick', 'youtube'];
                    if (ctx.dryRun) return { status: 'dry', detail: `would start the chat poll "${title.slice(0, 60)}" (${choices.join(' / ').slice(0, 150)}) for ${step.duration} s`, vars: { 'poll.id': '(dry-run)' } };
                    const r = await start(ctx.profile.id, { title, choices, seconds: step.duration, platforms });
                    return r.ok ? { status: 'ok', detail: `chat poll "${title.slice(0, 60)}" started for ${step.duration} s`, vars: { 'poll.id': r.id } } : { status: 'failed', detail: r.error };
                },
            },
            {
                type: 'poll.chat_end', label: 'End the chat poll', target: 'server', group: 'Polls and predictions', platforms: ['kick', 'youtube', 'twitch'],
                fields: [f('show', 'select', 'Result', { options: ['show', 'archive'], default: 'show', optionLabels: { show: 'End it and post the result', archive: 'End it quietly' } })],
                validate(s, out) { out.show = s.show === 'archive' ? 'archive' : 'show'; },
                async execute(step, ctx) {
                    if (ctx.dryRun) return { status: 'dry', detail: 'would end the chat poll' };
                    const r = await end(ctx.profile.id, step.show === 'archive' ? 'archived' : 'completed');
                    return r.ok ? { status: 'ok', detail: `chat poll ended${r.winner ? `: ${r.winner} wins` : ''}` } : { status: 'skipped', detail: r.error };
                },
            },
        ];
    }

    return { start, end, onChat, actions, running: (pid) => polls.has(Number(pid)) };
}

export default { createChatPolls, POLL_WHERE };
