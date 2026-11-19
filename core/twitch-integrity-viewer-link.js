/*
 * Indicator E: does the viewer count move with the known-bot accounts in chat? Works on one row per
 * live minute, { m, viewers, listed, other }, where m is a minute number, listed counts accounts on
 * the known-bot list and other counts everyone else in the chatter list. No database, so it can be tested.
 */
export const LINK = Object.freeze({
    minMinutes: 120,          // below this there is too little to compare
    minCorrelation: 0.7,      // viewers against listed accounts, across every minute
    minMoves: 2,              // a block leaving and a block returning
    moveMinAccounts: 20,      // listed accounts changing together...
    moveWindowMinutes: 5,     // ...within this long
    moveMinViewerShare: 0.5,  // viewers must shift by at least this share of the accounts that moved
    moveMaxOtherShare: 0.25,  // everyone else in chat must stay put, or it is an outage or a raid
    moveIgnoreStartMinutes: 30, // audiences arrive and restarts settle here
    moveIgnoreEndMinutes: 10,   // sign-off
    viewerLeadMinutes: 2,     // chatter lists lag the viewer count by about this much
    dipMinViewers: 30,        // viewer dips, context only
    dipMinShare: 0.6,
    dipHoldMinutes: 3,        // shorter is a null reading from Twitch
    dipRecoverMinutes: 30,
    dipIgnoreStartMinutes: 5,
    stretchGapMinutes: 120,   // chatter data further apart than this is a separate night
});

const median = (values) => {
    if (!values.length) return null;
    const v = values.slice().sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/** Pearson correlation, or null when either side never changes. */
export function pearson(xs, ys) {
    if (xs.length < 2 || xs.length !== ys.length) return null;
    const mx = mean(xs), my = mean(ys);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        dx += (xs[i] - mx) ** 2;
        dy += (ys[i] - my) ** 2;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

const sessionAt = (sessions, m) => sessions.find(s => m >= s.startM && m <= s.endM);

/** Listed accounts moving as a block while viewers follow and everyone else in chat stays put. */
export function linkedMoves(track, sessions) {
    const T = LINK;
    const moves = [];
    const during = (from, to, key) => track.filter(p => p.m >= from && p.m <= to).map(p => p[key]);
    let i = 0;
    while (i < track.length - 1) {
        let k = -1, best = 0;
        for (let j = i + 1; j < track.length && track[j].m - track[i].m <= T.moveWindowMinutes; j++) {
            const d = track[j].listed - track[i].listed;
            if (Math.abs(d) > Math.abs(best)) { best = d; k = j; }
        }
        if (Math.abs(best) < T.moveMinAccounts) { i++; continue; }

        let s = i;
        while (s + 1 < k && track[s + 1].listed === track[i].listed) s++;
        const dir = Math.sign(best);
        let e = k;
        for (let more = true; more;) {
            more = false;
            for (let j = e + 1; j < track.length && track[j].m - track[e].m <= 3; j++) {
                if (dir * (track[j].listed - track[e].listed) > 0) { e = j; more = true; break; }
            }
        }
        const start = track[s], end = track[e];
        i = e + 1;

        const session = sessionAt(sessions, start.m);
        if (!session || start.m - session.startM < T.moveIgnoreStartMinutes) continue;
        if (!session.open && session.endM - end.m <= T.moveIgnoreEndMinutes) continue;

        const beforeFrom = start.m - T.moveWindowMinutes - T.viewerLeadMinutes - 1;
        const beforeTo = start.m - T.viewerLeadMinutes;
        const afterTo = end.m + T.moveWindowMinutes;
        const viewersFrom = median(during(beforeFrom, beforeTo, 'viewers'));
        const viewersTo = median(during(end.m, afterTo, 'viewers'));
        const otherFrom = median(during(beforeFrom, beforeTo, 'other'));
        const otherTo = median(during(end.m, afterTo, 'other'));
        if (viewersFrom === null || viewersTo === null) continue;

        const accounts = Math.abs(end.listed - start.listed);
        const viewerShift = viewersTo - viewersFrom;
        if (Math.sign(viewerShift) !== dir || Math.abs(viewerShift) < accounts * T.moveMinViewerShare) continue;
        if (Math.abs(otherTo - otherFrom) >= accounts * T.moveMaxOtherShare) continue;
        moves.push({ m: start.m, endM: end.m, direction: dir < 0 ? 'left' : 'arrived', accounts,
                     listedFrom: start.listed, listedTo: end.listed, viewersFrom, viewersTo, otherFrom, otherTo });
    }
    return moves;
}

/** Viewer count falling sharply mid-stream and coming back. Works without chatter lists, so it covers more nights. */
export function viewerDips(series, sessions) {
    const T = LINK;
    const dips = [];
    for (let i = 3; i < series.length; i++) {
        const cur = series[i];
        const session = sessionAt(sessions, cur.m);
        if (!session || cur.m - session.startM < T.dipIgnoreStartMinutes) continue;
        if (!session.open && session.endM - cur.m <= T.moveIgnoreEndMinutes) continue;
        const prior = series.slice(i - 3, i).filter(p => cur.m - p.m <= 3);
        if (!prior.length) continue;
        const from = Math.max(...prior.map(p => p.v));
        const ceiling = from * (1 - T.dipMinShare);
        if (from < T.dipMinViewers || cur.v > ceiling) continue;
        const held = series.slice(i, i + T.dipHoldMinutes).filter(p => p.m - cur.m < T.dipHoldMinutes);
        if (held.length < T.dipHoldMinutes || held.some(p => p.v > ceiling)) continue;
        const back = series.slice(i).find(p => p.m - cur.m <= T.dipRecoverMinutes && p.v >= from * T.dipMinShare);
        if (!back) continue;
        const low = Math.min(...series.filter(p => p.m >= cur.m && p.m <= back.m).map(p => p.v));
        dips.push({ m: cur.m, from, low, backM: back.m, backTo: back.v });
        while (i + 1 < series.length && series[i + 1].m <= back.m) i++;
    }
    return dips;
}

/** One row per night of chatter data. The most common listed count shows how still that number sat. */
export function linkStretches(track) {
    const groups = [];
    for (const p of track) {
        const g = groups[groups.length - 1];
        if (g && p.m - g[g.length - 1].m <= LINK.stretchGapMinutes) g.push(p); else groups.push([p]);
    }
    return groups.map(g => {
        const counts = new Map();
        for (const p of g) counts.set(p.listed, (counts.get(p.listed) || 0) + 1);
        const [commonListed, commonMinutes] = Array.from(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
        return { fromM: g[0].m, toM: g[g.length - 1].m, minutes: g.length, commonListed, commonMinutes,
                 avgViewers: mean(g.map(p => p.viewers)), avgListed: mean(g.map(p => p.listed)), avgOther: mean(g.map(p => p.other)) };
    });
}

export function assessViewerLink(track, sessions) {
    const T = LINK;
    const moves = linkedMoves(track, sessions);
    const rListed = pearson(track.map(p => p.viewers), track.map(p => p.listed));
    const rOther = pearson(track.map(p => p.viewers), track.map(p => p.other));
    const assessed = track.length >= T.minMinutes;
    return {
        assessed,
        met: assessed ? (rListed !== null && rListed >= T.minCorrelation && moves.length >= T.minMoves) : null,
        minutes: track.length, rListed, rOther, moves, stretches: linkStretches(track),
    };
}
