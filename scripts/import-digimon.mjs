/*
 * Fills digimon_data and digimon_evolutions from digi-api.com (DAPI). Safe to re-run: rows are upserted,
 * and evolutions are rebuilt only for Digimon fetched successfully this run.
 *
 *   cd ~/CertiFriedUtility && set -a && source .env && set +a && node scripts/import-digimon.mjs
 *
 * One request at a time, ~4 a second, with an identifying User-Agent: it is a free community API.
 * Descriptions are Wikimon text under CC BY-SA, credited in the game's embeds.
 */
import pool from '../utils/db.js';
import { STAGES } from '../core/digimon-logic.js';

const API = 'https://digi-api.com/api/v1';
const UA = 'CertiFriedMultitool/1.0 (Discord bot; https://certifriedmultitool.com)';
const PAUSE_MS = 250;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, tries = 4) {
    for (let i = 1; ; i++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (err) {
            if (i >= tries) throw err;
            await sleep(2000 * i);
        }
    }
}

// The level the game treats as this Digimon's stage: the first one on the main line, else whatever it has.
function primaryLevel(levels) {
    return levels.find(l => STAGES.includes(l)) ?? levels[0] ?? 'Unknown';
}

const ids = [];
for (let page = 0; ; page++) {
    const list = await get(`${API}/digimon?pageSize=100&page=${page}`);
    const items = list?.content ?? [];
    ids.push(...items.map(d => d.id));
    // pageable.totalPages is one short (page 14 of "14" holds the last 88), so stop on a short page instead.
    if (items.length < 100) break;
    await sleep(PAUSE_MS);
}
console.log(`listed ${ids.length} digimon`);

let ok = 0, failed = 0;
const edges = new Map();
for (const id of ids) {
    try {
        const d = await get(`${API}/digimon/${id}`);
        if (!d) { failed++; continue; }
        const levels = (d.levels ?? []).map(l => l.level);
        const en = (d.descriptions ?? []).find(x => x.language === 'en_us')?.description ?? null;
        await pool.execute(
            `INSERT INTO digimon_data (id, name, level, levels, attributes, fields, types, skills, x_antibody, description, image_url, release_year)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), level = VALUES(level), levels = VALUES(levels),
               attributes = VALUES(attributes), fields = VALUES(fields), types = VALUES(types), skills = VALUES(skills),
               x_antibody = VALUES(x_antibody), description = VALUES(description), image_url = VALUES(image_url),
               release_year = VALUES(release_year)`,
            [d.id, d.name, primaryLevel(levels), JSON.stringify(levels),
             JSON.stringify((d.attributes ?? []).map(a => a.attribute)),
             JSON.stringify((d.fields ?? []).map(f => f.field)),
             JSON.stringify((d.types ?? []).map(t => t.type)),
             JSON.stringify((d.skills ?? []).map(s => s.translation || s.skill).filter(Boolean).slice(0, 8)),
             d.xAntibody ? 1 : 0, en, d.images?.[0]?.href ?? null, d.releaseDate ?? null]);
        edges.set(d.id, (d.nextEvolutions ?? []).map(e => e.id).filter(Number.isInteger));
        ok++;
        if (ok % 100 === 0) console.log(`  ${ok}/${ids.length}`);
    } catch (err) {
        failed++;
        console.log(`  ${id} failed: ${err.message}`);
    }
    await sleep(PAUSE_MS);
}

let edgeCount = 0;
for (const [from, tos] of edges) {
    await pool.execute('DELETE FROM digimon_evolutions WHERE from_id = ?', [from]);
    for (const to of new Set(tos)) {
        await pool.execute('INSERT IGNORE INTO digimon_evolutions (from_id, to_id) VALUES (?, ?)', [from, to]);
        edgeCount++;
    }
}
// Drop edges that point at a Digimon the API never returned, so a branch always resolves.
const [gone] = await pool.query('DELETE e FROM digimon_evolutions e LEFT JOIN digimon_data d ON d.id = e.to_id WHERE d.id IS NULL');

console.log(`imported ${ok}, failed ${failed}, evolution links ${edgeCount}, dangling removed ${gone.affectedRows}`);
await pool.end().catch(() => {});
process.exit(failed && !ok ? 1 : 0);
