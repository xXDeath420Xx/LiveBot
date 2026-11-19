// Greenhouse Tycoon (cfx v2): print the economy simulation (audit B3 test 4).
//   node services/cfx/sim/report.js [days...]            default: 30 90
//   node services/cfx/sim/report.js --replant [days...]  phase 4: quests, Replant, decorations (default 30 90 180)
import { pathToFileURL } from 'node:url';
import { simulate, netWorth, PROFILES, STRATEGIES, UPGRADE_TIERS } from './economy.js';

const RUNS = [
    ['casual', 'balanced'], ['regular', 'balanced'], ['heavy', 'balanced'],
    ['regular', 'grower'], ['regular', 'staff'], ['idle', 'staff'], ['casual', 'staff']
];

const fmt = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const pad = (s, n) => String(s).padEnd(n);

export function report(daysList = [30, 90]) {
    const lines = [];
    for (const days of daysList) {
        lines.push(`\n=== ${days} days ===`);
        lines.push([pad('profile/strategy', 28), pad('level', 6), pad('cash', 8), pad('net', 8), pad('income', 8), pad('staff%', 7), pad('upg', 4), pad('plots', 6), pad('staff', 6), pad('hyb', 4), 'tier days (5/10/20/30/40/50)', '  max claim h'].join(''));
        for (const [p, st] of RUNS) {
            const r = simulate({ profile: p, strategy: st, days, seed: 1 });
            const sm = r.summary;
            const tiers = UPGRADE_TIERS.map(tt => (sm.tierDay[tt] == null ? '-' : sm.tierDay[tt].toFixed(1))).join('/');
            lines.push([pad(`${p}/${st}`, 28), pad(sm.level, 6), pad(fmt(sm.cash), 8), pad(fmt(netWorth(r)), 8), pad(fmt(sm.totalIncome), 8),
                pad(`${Math.round(sm.staffShare * 100)}%`, 7), pad(sm.upgradeLevels, 4), pad(sm.plots, 6), pad(sm.staff, 6), pad(sm.hybrids, 4), pad(tiers, 30), sm.maxClaimCreditHours.toFixed(1)].join(''));
        }
    }
    return lines.join('\n');
}

export function curves(profile, strategy, days, every = 5) {
    const r = simulate({ profile, strategy, days, seed: 1 });
    const out = [`${PROFILES[profile].label} / ${STRATEGIES[strategy].label}`, 'day  level  cash      income    staff%'];
    for (const row of r.series) {
        if (row.day % every && row.day !== 1) continue;
        out.push(`${pad(row.day, 5)}${pad(row.level, 7)}${pad(fmt(row.cash), 10)}${pad(fmt(row.totalIncome), 10)}${Math.round(row.staffShare * 100)}%`);
    }
    return out.join('\n');
}

/**
 * Phase 4: what quests, Replant and decorations do (balanced strategy). Columns: without phase 4; with quests
 * and decorations; also replanting at the minimum level; also replanting only once the upgrade tree is done.
 */
export function metaReport(daysList = [30, 90, 180]) {
    const lines = [];
    const cell = (sm) => `L${sm.level} ${fmt(sm.totalIncome)} xp ${fmt(sm.xpEarned ?? 0)}`;
    for (const days of daysList) {
        lines.push(`\n=== ${days} days, phase 4 ===`);
        lines.push([pad('profile', 9), pad('phase 2 only', 24), pad('+ quests, decorations', 36), pad('+ Replant at min level', 34), '+ Replant when tree done'].join(''));
        for (const p of ['casual', 'regular', 'heavy']) {
            const base = simulate({ profile: p, strategy: 'balanced', days, seed: 1 }).summary;
            const meta = simulate({ profile: p, strategy: 'balanced', days, seed: 1, meta: true, decorate: true }).summary;
            const r1 = simulate({ profile: p, strategy: 'balanced', days, seed: 1, meta: true, decorate: true, replant: { atLevel: 25 } }).summary;
            const r2 = simulate({ profile: p, strategy: 'balanced', days, seed: 1, meta: true, decorate: true, replant: { atLevel: 25, whenTreeDone: true } }).summary;
            const pct = Math.round((meta.totalIncome / base.totalIncome - 1) * 100);
            lines.push([
                pad(p, 9), pad(cell(base), 24),
                pad(`${cell(meta)} +${pct}% d${meta.decorations}`, 36),
                pad(`${cell(r1)} R${r1.prestige}`, 34),
                `${cell(r2)} R${r2.prestige} (days ${r2.replants.map(r => r.day.toFixed(0)).join('/') || '-'})`
            ].join(''));
        }
    }
    return lines.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const args = process.argv.slice(2);
    const days = args.map(Number).filter(n => n > 0);
    if (args.includes('--replant')) console.log(metaReport(days.length ? days : [30, 90, 180]));
    else console.log(report(days.length ? days : [30, 90]));
    if (process.env.SIM_CURVES) for (const p of ['casual', 'regular', 'heavy']) console.log('\n' + curves(p, 'balanced', 90, 10));
}
