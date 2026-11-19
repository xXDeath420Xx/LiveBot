/*
 * Fills digimon_dna from digi-api.com (DAPI): the DNA Digivolutions named in evolution conditions, such as
 * Stingmon → Paildramon "with XV-mon". Only Perfect and Ultimate Digimon are fetched, since DNA makes those.
 * Safe to re-run: a Digimon's rows are replaced only when it was fetched successfully.
 *
 *   cd ~/CertiFriedUtility && set -a && source .env && set +a && node scripts/import-digimon-dna.mjs
 *
 * Same manners as import-digimon.mjs: one request at a time, ~4 a second, an identifying User-Agent.
 */
import pool from '../utils/db.js';
import { normaliseName, parseDnaPartners } from '../core/digimon-logic.js';

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

// Every Digimon by normalised name, with and without its bracketed variant ("Greymon (Blue)" → greymonblue).
const [all] = await pool.query('SELECT id, name FROM digimon_data');
const byName = new Map();
for (const r of all) {
    for (const key of new Set([normaliseName(r.name), normaliseName(r.name.replace(/\(.*?\)/g, ''))])) {
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(r.id);
    }
}
// Exact full names win over the bracket-less form, so "Greymon" means Greymon, not every Greymon variant.
const exact = new Map(all.map(r => [normaliseName(r.name), r.id]));
const resolve = key => (exact.has(key) ? [exact.get(key)] : byName.get(key) ?? []);

const [targets] = await pool.query(
    `SELECT id, name FROM digimon_data WHERE JSON_CONTAINS(levels, '"Perfect"') OR JSON_CONTAINS(levels, '"Ultimate"') ORDER BY id`);
console.log(`checking ${targets.length} Perfect/Ultimate Digimon`);

let fetched = 0, failed = 0, pairs = 0, unmatched = 0;
for (const t of targets) {
    try {
        const d = await get(`${API}/digimon/${t.id}`);
        if (!d) { failed++; continue; }
        const rows = [];
        for (const e of d.priorEvolutions ?? []) {
            if (!Number.isInteger(e.id)) continue;
            for (const key of parseDnaPartners(e.condition)) {
                const ids = resolve(key);
                if (!ids.length) unmatched++;
                for (const withId of ids) rows.push([e.id, withId, t.id]);
            }
        }
        await pool.execute('DELETE FROM digimon_dna WHERE to_id = ?', [t.id]);
        if (rows.length) await pool.query('INSERT IGNORE INTO digimon_dna (from_id, with_id, to_id) VALUES ?', [rows]);
        pairs += rows.length;
        fetched++;
        if (fetched % 100 === 0) console.log(`  ${fetched}/${targets.length} · ${pairs} pairs`);
    } catch (err) {
        failed++;
        console.log(`  ${t.id} ${t.name} failed: ${err.message}`);
    }
    await sleep(PAUSE_MS);
}
console.log(`done: ${fetched} fetched, ${failed} failed, ${pairs} DNA pairs, ${unmatched} partner names not in the data`);
process.exit(0);
