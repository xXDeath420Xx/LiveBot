// node scripts/theme-audit/analyse.mjs /tmp/themes-before/report.json [theme] [--pages] [--islands] [--page id]
import fs from 'node:fs';
const [file, theme = null, ...flags] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(JSON.stringify(r.summary));
const themes = theme && !theme.startsWith('--') ? [theme] : r.themes;
const pageArg = flags.indexOf('--page');
if (pageArg >= 0) {
    const id = flags[pageArg + 1];
    for (const t of themes) {
        const e = r.pages[id]?.[t]; if (!e) continue;
        console.log(`== ${id} ${t} v=${e.violations} fp=${e.firstPaint?.ok} ${e.failed || ''} errs=${e.errors.length}`);
        e.nodes.forEach((n) => console.log(`  V ${n.fg} on ${n.bg} ${n.ratio}  ${n.target.slice(0, 90)}  | ${n.html.slice(0, 90)}`));
        e.islands.forEach((n) => console.log(`  I ${n.bg} ${n.w}x${n.h} ${n.sel}`));
    }
    process.exit(0);
}
for (const t of themes) {
    const pairs = new Map(), sels = new Map(), pages = [];
    for (const [id, p] of Object.entries(r.pages)) {
        const e = p[t]; if (!e) continue;
        if (e.violations || e.islands.length || e.failed || (e.firstPaint && !e.firstPaint.ok)) pages.push([id, e.violations, e.islands.length, e.failed ? 'FAIL' : '', e.firstPaint?.ok === false ? 'FLASH' : '']);
        for (const n of e.nodes) {
            const k = `${n.fg} on ${n.bg}`;
            pairs.set(k, (pairs.get(k) || 0) + 1);
            const cls = (n.html.match(/class="([^"]+)"/) || [, n.target])[1].split(/\s+/).slice(0, 2).join('.');
            const sk = `${n.html.match(/^<(\w+)/)?.[1] || '?'}.${cls}`;
            if (!sels.has(sk)) sels.set(sk, { n: 0, pages: new Set(), ex: `${k} ${n.ratio}` });
            const s = sels.get(sk); s.n++; s.pages.add(id);
        }
    }
    console.log(`\n######## ${t}: ${pages.length} pages with findings`);
    if (flags.includes('--pages')) pages.sort((a, b) => b[1] - a[1]).forEach((p) => console.log('  ', p.join(' ')));
    console.log('-- top colour pairs');
    [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, n]) => console.log(`  ${n}  ${k}`));
    console.log('-- top elements');
    [...sels].sort((a, b) => b[1].n - a[1].n).slice(0, 60).forEach(([k, s]) => console.log(`  ${s.n} (${s.pages.size}p) ${k}  [${s.ex}]  e.g. ${[...s.pages].slice(0, 3).join(',')}`));
    if (flags.includes('--islands')) {
        const isl = new Map();
        for (const [id, p] of Object.entries(r.pages)) for (const n of (p[t]?.islands || [])) { const k = `${n.sel} ${n.bg}`; if (!isl.has(k)) isl.set(k, new Set()); isl.get(k).add(id); }
        console.log('-- islands');
        [...isl].sort((a, b) => b[1].size - a[1].size).slice(0, 60).forEach(([k, s]) => console.log(`  ${s.size}p ${k}  e.g. ${[...s].slice(0, 3).join(',')}`));
    }
}
