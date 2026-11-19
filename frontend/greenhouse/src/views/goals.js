// Phase 4 goals: daily and weekly quests with the weekly challenge (Grow tab), the season with its
// leaderboard and reward tiers, and achievements with badges (Profile tab). Registered in phase4.js.
import { h } from '../lib/dom.js';
import { money, count } from '../lib/format.js';
import { UI } from '../copy.js';
import { icon } from '../art/icons.js';
import { openDialog } from '../ui/dialog.js';
import { actionButton, progress, countdown, segmented } from '../ui/widgets.js';

const Q = UI.quests;
const S = UI.season;
const A = UI.achievements;

/** Load something once per state version into app.mem[key]; the tab re-renders when it arrives. */
function loader(app, key, path, pick, tab) {
    if (!app.mem[key]) app.mem[key] = { data: null, loadedFor: null, loading: false };
    const m = app.mem[key];
    const version = app.state.version;
    if (!m.loading && m.loadedFor !== version) {
        m.loading = true;
        app.api.get(path)
            .then((d) => { m.data = pick(d); m.loadedFor = version; })
            .catch((err) => { m.loadedFor = version; app.reportError(err); })
            .finally(() => { m.loading = false; if (!tab || app.tab === tab) app.render(); });
    }
    return m.data;
}

// ------------------------------------------------------------------ quests (Grow tab)

function questRow(app, q) {
    const done = q.completed;
    const id = `quest-${q.periodKey}-${q.code}`;
    return h('li', { class: ['quest', done && 'quest-done'] },
        h('div', { class: 'quest-main' },
            h('p', { class: 'quest-title', id }, q.title),
            progress(q.progress / Math.max(1, q.target), { label: `${q.title}: ${Q.progress(count(q.progress), count(q.target))}`, cls: 'progress-thin' }),
            h('p', { class: 'muted small' }, Q.progress(count(q.progress), count(q.target)), ', ', Q.reward(money(q.reward.cash), count(q.reward.xp)))),
        q.claimed ? h('span', { class: 'chip' }, Q.claimed)
            : done ? actionButton(Q.claim, () => app.act('/quests/claim', { periodKey: q.periodKey, code: q.code }, {
                done: (r) => app.toast(Q.claimedToast(money(r.cash ?? q.reward.cash), count(r.xp ?? q.reward.xp)))
            }), { small: true, key: `quest-claim-${q.periodKey}-${q.code}`, describedBy: id }) : null);
}

function challengeBlock(app) {
    const season = app.state.season;
    if (!season) return null;
    const c = season.challenge;
    const now = app.now();
    if (!c) {
        if (!season.nextChallengeAtMs) return null;
        return h('div', { class: 'quest-challenge' },
            h('p', { class: 'eyebrow' }, Q.challenge),
            h('p', { class: 'muted small' }, countdown(season.nextChallengeAtMs, now, { format: Q.challengeNext, done: '' })));
    }
    if (c.status === 'scheduled') {
        // Its week has begun but too few players have been active yet; it starts by itself once enough have.
        return h('div', { class: 'quest-challenge' },
            h('p', { class: 'eyebrow' }, Q.challenge),
            h('p', { class: 'strong' }, c.title),
            h('p', { class: 'muted small' }, Q.challengeWaiting(c.activePlayers ?? 0, c.minActivePlayers)));
    }
    if (c.status === 'skipped') {
        return h('div', { class: 'quest-challenge' },
            h('p', { class: 'eyebrow' }, Q.challenge),
            h('p', { class: 'strong' }, c.title),
            h('p', { class: 'muted small' }, Q.challengeSkipped(c.activePlayers ?? 0, c.minActivePlayers)));
    }
    const id = `challenge-${c.id}`;
    return h('div', { class: 'quest-challenge' },
        h('p', { class: 'eyebrow' }, icon('flag', { size: 14 }), ' ', Q.challenge),
        h('p', { class: 'strong', id }, c.title),
        progress(c.progress / Math.max(1, c.target), { label: `${c.title}: ${Q.progress(c.progress, c.target)}` }),
        h('p', { class: 'muted small' }, Q.progress(count(c.progress), count(c.target)), ', ',
            c.completed ? Q.challengeDone : countdown(c.endsAtMs, now, { format: Q.challengeEnds, done: S.ending })),
        c.completed ? null : h('p', { class: 'muted small' }, Q.challengeReward(money(c.reward.cash), count(c.reward.xp))));
}

/** The quests card: today's, this week's, ones done earlier but not collected, and the weekly challenge. */
export function questsCard(app) {
    const qs = app.state.quests;
    if (!qs) return null;
    const now = app.now();
    const current = (list) => list.filter(q => !q.previous);
    const earlier = [...qs.daily, ...qs.weekly].filter(q => q.previous && q.completed && !q.claimed);
    const group = (title, list, resetsAt) => (list.length ? h('div', { class: 'stack-sm' },
        h('div', { class: 'quest-head' }, h('h3', { class: 'quest-group' }, title),
            resetsAt ? h('span', { class: 'muted small' }, countdown(resetsAt, now, { format: Q.resetsIn, done: '' })) : null),
        h('ul', { class: 'quest-list', role: 'list' }, list.map(q => questRow(app, q)))) : null);
    const daily = current(qs.daily);
    const weekly = current(qs.weekly);
    return h('section', { class: 'card stack', 'aria-labelledby': 'gh-quests-title' },
        h('h2', { class: 'card-title', id: 'gh-quests-title' }, Q.title,
            qs.claimable ? [' ', h('span', { class: 'chip chip-accent' }, A.toCollect(qs.claimable))] : null),
        earlier.length ? group(Q.earlier, earlier, null) : null,
        group(Q.daily, daily, qs.dailyResetsAtMs),
        group(Q.weekly, weekly, qs.weeklyResetsAtMs),
        !daily.length && !weekly.length ? h('p', { class: 'muted small' }, Q.none) : null,
        challengeBlock(app));
}

/** A one-line reminder at the top of the Grow tab when quest rewards are waiting. */
export function questsReminder(app) {
    const n = app.state.quests ? app.state.quests.claimable : 0;
    if (!n) return null;
    return h('div', { class: 'notice notice-info reminder' }, icon('star', { size: 16 }), h('p', null, Q.doneBanner(n)),
        h('button', {
            type: 'button', class: 'btn btn-secondary btn-sm', dataset: { key: 'quests-show' },
            on: { click: () => {
                const target = document.querySelector('[data-key^="quest-claim-"]');
                if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
            } }
        }, Q.show));
}

// ------------------------------------------------------------------ season and leaderboard (Profile tab)

function rewardRule(rule) {
    if (rule.maxRank != null) return S.rewardRule.maxRank(rule.maxRank);
    if (rule.topPct != null) return S.rewardRule.topPct(rule.topPct);
    return S.rewardRule.minScore(rule.minScore);
}

export function seasonCard(app) {
    const s = app.state.season;
    const detail = loader(app, 'seasonDetail', '/season', d => d, 'profile');
    const now = app.now();
    if (!s) {
        return h('section', { class: 'card stack-sm', 'aria-labelledby': 'gh-season-title' },
            h('h2', { class: 'card-title', id: 'gh-season-title' }, S.leaderboard),
            h('p', { class: 'muted small' }, S.none),
            h('div', null, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { key: 'open-board' }, on: { click: () => leaderboardDialog(app, 'alltime') } }, S.openBoard)));
    }
    const review = app.state.account.review;
    const last = detail && detail.lastSeason;
    return h('section', { class: 'card stack', 'aria-labelledby': 'gh-season-title' },
        h('div', { class: 'card-foot' },
            h('h2', { class: 'card-title', id: 'gh-season-title' }, S.title(s.number)),
            h('span', { class: 'muted small' }, s.status === 'active' && s.endsAtMs > now ? countdown(s.endsAtMs, now, { format: S.ends, done: S.ending }) : S.ending)),
        h('dl', { class: 'stats' },
            h('div', { class: 'stat' }, h('dt', null, S.score), h('dd', null, count(s.score))),
            h('div', { class: 'stat' }, h('dt', null, S.rank), h('dd', null, review ? UI.review.locked : s.rank ? S.rankOf(s.rank) : S.unranked)),
            h('div', { class: 'stat' }, h('dt', null, S.todayLabel), h('dd', null, Q.progress(count(s.scoreToday), count(s.dailyCap))))),
        progress(s.scoreToday / Math.max(1, s.dailyCap), { label: S.today(s.scoreToday, s.dailyCap), cls: 'progress-thin' }),
        h('p', { class: 'muted small' }, S.todayHelp),
        last && last.rank ? h('p', { class: 'small' }, S.lastSeason(last.number, last.rank, last.ranked), last.reward ? [' ', S.lastReward(last.reward.tierName, money(last.reward.cash))] : null) : null,
        detail && detail.tiers ? h('details', { class: 'tiers' },
            h('summary', null, S.rewards),
            h('ul', { class: 'tier-list', role: 'list' }, detail.tiers.map(t => h('li', null,
                h('span', { class: 'strong' }, t.name), ` (${rewardRule(t.rule)}): `, money(t.cash), ', ', S.badge, t.decoration ? `, ${t.decoration}` : '')))) : null,
        h('div', null, h('button', {
            type: 'button', class: 'btn btn-secondary', dataset: { key: 'open-board' },
            on: { click: () => leaderboardDialog(app, 'season') }
        }, icon('list', { size: 18 }), ' ', S.openBoard)));
}

/** The leaderboard dialog: season or all time, 20 a page, with the player's own place under the list. */
export function leaderboardDialog(app, board = 'season') {
    const m = { board, page: 1, data: null, loading: false, error: false };
    let entry = null;
    function load() {
        m.loading = true;
        app.api.get(`/leaderboard?board=${m.board}&page=${m.page}`)
            .then((d) => { m.data = d.leaderboard; m.error = false; })
            .catch((err) => { m.error = true; app.reportError(err); })
            .finally(() => { m.loading = false; if (entry) entry.refresh(); });
    }
    const go = (patch) => { Object.assign(m, patch); load(); if (entry) entry.refresh(); };
    entry = openDialog({
        title: S.leaderboard,
        className: 'dialog-wide',
        render: () => {
            const d = m.data;
            const pages = d ? Math.max(1, Math.min(25, Math.ceil(d.total / d.pageSize))) : 1;
            const unit = m.board === 'season' ? S.points : S.xp;
            return h('div', { class: 'stack' },
                segmented(S.leaderboard, [['season', S.boards.season], ['alltime', S.boards.alltime]], m.board, (v) => go({ board: v, page: 1, data: null })),
                !d ? h('p', { class: 'muted small', role: 'status' }, S.loading)
                    : d.rows.length ? h('ol', { class: 'board', role: 'list' }, d.rows.map(r => h('li', { class: 'board-row' },
                        h('span', { class: 'board-rank' }, S.rankOf(r.rank)),
                        h('span', { class: 'board-name' }, r.displayName,
                            r.prestige ? [' ', h('span', { class: 'chip' }, S.replants(r.prestige))] : null),
                        h('span', { class: 'board-score' }, unit(count(r.score))))))
                        : h('p', { class: 'muted small' }, S.emptyBoard),
                d ? h('p', { class: 'small board-me' }, h('span', { class: 'strong' }, S.you), ': ',
                    d.me && d.me.rank ? `${S.rankOf(d.me.rank)}, ${unit(count(d.me.score))}` : S.notOnBoard) : null,
                d && pages > 1 ? h('div', { class: 'card-foot' },
                    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: m.page <= 1 || m.loading, dataset: { key: 'board-prev' }, on: { click: () => go({ page: m.page - 1 }) } }, S.prev),
                    h('span', { class: 'muted small' }, S.page(m.page, pages)),
                    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: m.page >= pages || m.loading, dataset: { key: 'board-next' }, on: { click: () => go({ page: m.page + 1 }) } }, S.next)) : null);
        }
    });
    load();
}

// ------------------------------------------------------------------ achievements and badges (Profile tab)

function achievementRow(app, a, { compact = false } = {}) {
    const id = `ach-${a.code}`;
    return h('li', { class: ['quest', a.unlocked && 'quest-done'] },
        h('div', { class: 'quest-main' },
            h('p', { class: 'quest-title', id }, a.name),
            compact ? null : h('p', { class: 'muted small' }, a.description),
            compact || a.unlocked ? null : progress(a.progress / Math.max(1, a.target), { label: `${a.name}: ${count(a.progress)} of ${count(a.target)}`, cls: 'progress-thin' }),
            h('p', { class: 'muted small' }, A.reward(a.reward.cash ? money(a.reward.cash) : null, a.reward.badge))),
        a.claimed ? h('span', { class: 'chip' }, A.done)
            : a.unlocked ? actionButton(A.claim, () => app.act('/achievements/claim', { code: a.code }, {
                done: (r) => {
                    app.toast(A.claimedToast(a.name, money(r.cash ?? a.reward.cash), r.badge || a.reward.badge));
                    if (app.mem.achievements) app.mem.achievements.loadedFor = null;
                }
            }), { small: true, key: `ach-claim-${a.code}`, describedBy: id })
                : h('span', { class: 'chip' }, `${count(a.progress)} / ${count(a.target)}`));
}

export function achievementsCard(app) {
    const sum = app.state.achievements;
    const data = loader(app, 'achievements', '/achievements', d => d, 'profile');
    const badges = data ? data.badges : (app.state.cosmetics ? app.state.cosmetics.badges : []);
    const ready = data ? data.achievements.filter(a => a.unlocked && !a.claimed) : [];
    return h('section', { class: 'card stack', 'aria-labelledby': 'gh-ach-title' },
        h('h2', { class: 'card-title', id: 'gh-ach-title' }, icon('star', { size: 18 }), ' ', A.title, ' ',
            h('span', { class: 'chip' }, A.count(sum ? sum.unlocked : 0, sum ? sum.total : 0)),
            sum && sum.claimable ? [' ', h('span', { class: 'chip chip-accent' }, A.toCollect(sum.claimable))] : null),
        ready.length ? h('ul', { class: 'quest-list', role: 'list' }, ready.map(a => achievementRow(app, a, { compact: true }))) : null,
        h('div', null, h('h3', { class: 'quest-group' }, A.badges),
            badges && badges.length
                ? h('ul', { class: 'badges', role: 'list' }, badges.map(b => h('li', { class: 'badge' }, icon('star', { size: 14 }), ' ', b.name)))
                : h('p', { class: 'muted small' }, A.noBadges)),
        h('div', null, h('button', {
            type: 'button', class: 'btn btn-secondary btn-sm', dataset: { key: 'ach-all' }, disabled: !data,
            on: { click: () => openDialog({
                title: A.title,
                className: 'dialog-wide',
                render: () => {
                    const d = app.mem.achievements && app.mem.achievements.data;
                    if (!d) return h('p', { class: 'muted small' }, A.loading);
                    return h('ul', { class: 'quest-list', role: 'list' }, d.achievements.map(a => achievementRow(app, a)));
                }
            }) }
        }, A.all)));
}

