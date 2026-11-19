/**
 * Digimon API — `/api/guilds/:guildId/digimon/*`
 *
 * The dashboard page for /digimon: numbers at a glance, the strongest partners, today's quiz results, the
 * market, and resets. Settings are saved through the generic feature-config route (spec `digimon`), so this
 * router only reads, takes down listings and resets.
 *
 * Gated by `apiCheckGuildAdmin` on the parent router; every query is scoped to the URL's guild.
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { getConfig } from '../../../../core/feature-config.js';
import { Worker } from 'node:worker_threads';
import {
    quizDay, POWER_LEVELS, QUESTION_BANK, CATEGORIES, ATTRIBUTES, FIELDS, FAMILIES, CRESTS, POWER_WORDS, QUESTION_LIMITS,
    familyWord, validateQuestion, buildBank, bankBalance,
} from '../../../../core/digimon-quiz.js';
import { quizRows } from '../../../../core/digimon-quiz-bank.js';
import { RARITY, stableHash } from '../../../../core/digimon-logic.js';
import { QUIZ_TIERS } from '../../../../core/digimon-quiz-odds.js';
import { cancelListing } from '../../../../commands/games/digimon.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAGE_ORDER = `FIELD(d.level, 'Ultimate', 'Perfect', 'Adult', 'Child', 'Baby II', 'Baby I')`;

async function namesFor(guild, ids) {
    const names = new Map();
    const unique = [...new Set(ids.filter(Boolean))];
    if (!guild || !unique.length) return names;
    for (let i = 0; i < unique.length; i += 100) {
        const found = await guild.members.fetch({ user: unique.slice(i, i + 100) }).catch(() => null);
        found?.forEach(m => names.set(m.id, { name: m.displayName, avatar: m.displayAvatarURL({ size: 32 }) }));
    }
    return names;
}

const who = (names, id) => ({ id, name: names.get(id)?.name ?? null, avatar: names.get(id)?.avatar ?? null });
const fail = (res, what, err) => {
    logger.error(`[DigimonAPI] ${what}`, { error: err.message });
    res.status(500).json({ success: false, error: `Could not load ${what}.` });
};

router.get('/', async (req, res) => {
    try {
        const g = req.params.guildId;
        const day = quizDay();
        const one = async (sql, params) => Number((await pool.execute(sql, params))[0][0].n);
        const [byStage] = await pool.execute(
            `SELECT d.level AS stage, COUNT(*) AS n FROM user_digimon u JOIN digimon_data d ON d.id = u.digimon_id
              WHERE u.guild_id = ? AND u.is_partner = 1 GROUP BY d.level`, [g]);
        const [speciesByStage] = await pool.execute('SELECT level, COUNT(*) AS n FROM digimon_data GROUP BY level');
        const speciesIn = Object.fromEntries(speciesByStage.map(r => [r.level, Number(r.n)]));
        res.json({
            success: true,
            config: await getConfig('digimon', g),
            day,
            stats: {
                players: await one('SELECT COUNT(DISTINCT user_id) AS n FROM user_digimon WHERE guild_id = ?', [g]),
                owned: await one('SELECT COUNT(*) AS n FROM user_digimon WHERE guild_id = ?', [g]),
                quizToday: await one('SELECT COUNT(*) AS n FROM digimon_quiz_results WHERE guild_id = ? AND day = ?', [g, day]),
                quizTotal: await one('SELECT COUNT(*) AS n FROM digimon_quiz_results WHERE guild_id = ?', [g]),
                listings: await one(`SELECT COUNT(*) AS n FROM digimon_market WHERE guild_id = ? AND status = 'open'`, [g]),
                sales7d: await one(`SELECT COUNT(*) AS n FROM digimon_market WHERE guild_id = ? AND status = 'sold' AND closed_at > NOW() - INTERVAL 7 DAY`, [g]),
                trades7d: await one(`SELECT COUNT(*) AS n FROM digimon_trades WHERE guild_id = ? AND status = 'done' AND finished_at > NOW() - INTERVAL 7 DAY`, [g]),
                species: await one('SELECT COUNT(*) AS n FROM digimon_data', []),
                byStage: Object.fromEntries(byStage.map(r => [r.stage, Number(r.n)])),
            },
            rarity: RARITY.map(t => ({ name: t.name, stage: t.stage, chance: t.chance, tame: t.tame, species: speciesIn[t.stage] ?? 0 })),
        });
    } catch (err) { fail(res, 'the Digimon overview', err); }
});

/*
 * Odds of every /digimon today result over the next year (core/digimon-quiz-odds.js), for this server's
 * questions. Servers with the same questions (most keep the built-in set) share one copy, kept for a day; a
 * change to a server's questions gives it a new copy. The year of quiz runs takes ~2.5 s and runs in a worker
 * thread so the bot and dashboard keep answering meanwhile; page loads during a run share it.
 */
const ODDS_CACHE_MS = 24 * 60 * 60 * 1000;
const ODDS_CACHE_MAX = 50;
const oddsCache = new Map();   // bank signature → { at, value }
const oddsRunning = new Map(); // bank signature → promise
const jsonCol = v => (Array.isArray(v) ? v : (() => { try { return JSON.parse(v); } catch { return []; } })());

async function quizOdds(bank) {
    const sig = String(stableHash(JSON.stringify(bank)));
    const hit = oddsCache.get(sig);
    if (hit && Date.now() - hit.at < ODDS_CACHE_MS) return hit.value;
    if (oddsRunning.has(sig)) return oddsRunning.get(sig);
    const run = (async () => {
        const [rows] = await pool.query('SELECT id, name, level, attributes, fields, types FROM digimon_data WHERE level IN (?)', [POWER_LEVELS]);
        const digimon = rows.map(r => ({ ...r, attributes: jsonCol(r.attributes), fields: jsonCol(r.fields), types: jsonCol(r.types) }));
        const value = await new Promise((resolve, reject) => {
            const worker = new Worker(new URL('../../../../core/digimon-quiz-odds-worker.js', import.meta.url),
                { workerData: { digimon, startMs: Date.now(), bank } });
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('exit', code => { if (code !== 0) reject(new Error(`odds worker stopped with code ${code}`)); });
        });
        if (oddsCache.size >= ODDS_CACHE_MAX) oddsCache.delete(oddsCache.keys().next().value);
        oddsCache.set(sig, { at: Date.now(), value });
        return value;
    })().finally(() => oddsRunning.delete(sig));
    oddsRunning.set(sig, run);
    return run;
}

router.get('/quiz-odds', async (req, res) => {
    try {
        const rows = await quizRows(req.params.guildId);
        const value = await quizOdds(buildBank(rows));
        res.json({ success: true, tiers: QUIZ_TIERS.map(({ name, band }) => ({ name, band })), ownQuestions: rows.length > 0, ...value });
    } catch (err) { fail(res, 'the quiz odds', err); }
});

/*
 * Quiz questions editor (dashboard page digimon-quiz). A question is addressed by `ref`: `b<n>` is built-in
 * QUESTION_BANK[n] (a change is stored as an override row; deleting the row puts the original back), `c<id>`
 * is one this server wrote. Every write is checked by validateQuestion.
 */
const MAX_OWN_QUESTIONS = 200;
const sameQuestion = (a, b) => JSON.stringify({ cat: a.cat, q: a.q, options: a.options }) === JSON.stringify({ cat: b.cat, q: b.q, options: b.options });
const optionsOf = o => o.map(({ label, a, f, t, c, p }) => ({ label, a, f: f ?? null, t: t ?? null, c: c ?? null, p }));

function parseRef(ref) {
    const m = String(ref).match(/^([bc])(\d{1,9})$/);
    if (!m) return null;
    const n = Number(m[2]);
    if (m[1] === 'b') return n < QUESTION_BANK.length ? { builtin: n } : null;
    return { id: n };
}

router.get('/quiz-questions', async (req, res) => {
    try {
        const rows = await quizRows(req.params.guildId);
        const byIndex = new Map(rows.filter(r => r.builtin_index !== null).map(r => [Number(r.builtin_index), r]));
        const builtins = QUESTION_BANK.map((orig, i) => {
            const row = byIndex.get(i);
            const current = row ? { cat: row.cat, q: row.q, options: jsonCol(row.options) } : { cat: orig.cat, q: orig.q, options: optionsOf(orig.options) };
            const original = { cat: orig.cat, q: orig.q, options: optionsOf(orig.options) };
            return { ref: `b${i}`, ...current, enabled: row ? Boolean(Number(row.enabled)) : true, edited: !sameQuestion(current, original), original };
        });
        const own = rows.filter(r => r.builtin_index === null)
            .map(r => ({ ref: `c${r.id}`, cat: r.cat, q: r.q, options: jsonCol(r.options), enabled: Boolean(Number(r.enabled)) }));
        const anyOn = builtins.some(q => q.enabled) || own.some(q => q.enabled);
        res.json({
            success: true,
            builtins, own,
            balance: bankBalance(buildBank(rows)),
            allOff: !anyOn,
            tags: {
                categories: CATEGORIES, attributes: ATTRIBUTES, fields: FIELDS, powerWords: POWER_WORDS, limits: QUESTION_LIMITS,
                families: FAMILIES.map(([key]) => ({ key, word: familyWord(key) })),
                crests: Object.entries(CRESTS).map(([key, c]) => ({ key, name: c.name })),
            },
        });
    } catch (err) { fail(res, 'the quiz questions', err); }
});

// A new question of this server's own.
router.post('/quiz-questions', async (req, res) => {
    try {
        const g = req.params.guildId;
        const { value, error } = validateQuestion(req.body);
        if (error) return res.status(400).json({ success: false, error });
        const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM digimon_quiz_questions WHERE guild_id = ? AND builtin_index IS NULL', [g]);
        if (n >= MAX_OWN_QUESTIONS) return res.status(400).json({ success: false, error: `This server already has ${MAX_OWN_QUESTIONS} questions of its own.` });
        const [r] = await pool.execute('INSERT INTO digimon_quiz_questions (guild_id, cat, q, options) VALUES (?, ?, ?, ?)',
            [g, value.cat, value.q, JSON.stringify(value.options)]);
        res.json({ success: true, ref: `c${r.insertId}` });
    } catch (err) { fail(res, 'the new question', err); }
});

// Change a question's wording or answers.
router.put('/quiz-questions/:ref', async (req, res) => {
    try {
        const g = req.params.guildId;
        const ref = parseRef(req.params.ref);
        if (!ref) return res.status(404).json({ success: false, error: 'No such question.' });
        const { value, error } = validateQuestion(req.body);
        if (error) return res.status(400).json({ success: false, error });
        if (ref.builtin !== undefined) {
            await pool.execute(
                `INSERT INTO digimon_quiz_questions (guild_id, builtin_index, cat, q, options) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE cat = VALUES(cat), q = VALUES(q), options = VALUES(options)`,
                [g, ref.builtin, value.cat, value.q, JSON.stringify(value.options)]);
        } else {
            const [r] = await pool.execute('UPDATE digimon_quiz_questions SET cat = ?, q = ?, options = ? WHERE id = ? AND guild_id = ? AND builtin_index IS NULL',
                [value.cat, value.q, JSON.stringify(value.options), ref.id, g]);
            if (!r.affectedRows) return res.status(404).json({ success: false, error: 'No such question.' });
        }
        res.json({ success: true });
    } catch (err) { fail(res, 'the question', err); }
});

// Turn a question on or off.
router.post('/quiz-questions/:ref/enabled', async (req, res) => {
    try {
        const g = req.params.guildId;
        const ref = parseRef(req.params.ref);
        if (!ref) return res.status(404).json({ success: false, error: 'No such question.' });
        const on = req.body?.enabled ? 1 : 0;
        if (ref.builtin !== undefined) {
            const orig = QUESTION_BANK[ref.builtin];
            // Turning a built-in off stores an override row; an existing row keeps its edited text.
            await pool.execute(
                `INSERT INTO digimon_quiz_questions (guild_id, builtin_index, cat, q, options, enabled) VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
                [g, ref.builtin, orig.cat, orig.q, JSON.stringify(optionsOf(orig.options)), on]);
        } else {
            const [r] = await pool.execute('UPDATE digimon_quiz_questions SET enabled = ? WHERE id = ? AND guild_id = ? AND builtin_index IS NULL', [on, ref.id, g]);
            if (!r.affectedRows) return res.status(404).json({ success: false, error: 'No such question.' });
        }
        res.json({ success: true });
    } catch (err) { fail(res, 'the question', err); }
});

// A built-in goes back to the original; a server's own question is deleted.
router.delete('/quiz-questions/:ref', async (req, res) => {
    try {
        const g = req.params.guildId;
        const ref = parseRef(req.params.ref);
        if (!ref) return res.status(404).json({ success: false, error: 'No such question.' });
        if (ref.builtin !== undefined) {
            await pool.execute('DELETE FROM digimon_quiz_questions WHERE guild_id = ? AND builtin_index = ?', [g, ref.builtin]);
        } else {
            await pool.execute('DELETE FROM digimon_quiz_questions WHERE guild_id = ? AND id = ? AND builtin_index IS NULL', [g, ref.id]);
        }
        res.json({ success: true });
    } catch (err) { fail(res, 'the question', err); }
});

router.get('/leaderboard', async (req, res) => {
    try {
        const g = req.params.guildId;
        const [rows] = await pool.execute(
            `SELECT u.user_id, u.nickname, u.level, u.wins, u.battles, u.care_mistakes, d.name, d.level AS stage,
                    (SELECT COUNT(*) FROM user_digimon o WHERE o.guild_id = u.guild_id AND o.user_id = u.user_id) AS owned,
                    (SELECT COUNT(*) FROM user_digimon_dex x WHERE x.guild_id = u.guild_id AND x.user_id = u.user_id) AS met
               FROM user_digimon u JOIN digimon_data d ON d.id = u.digimon_id
              WHERE u.guild_id = ? AND u.team_slot = 1
              ORDER BY ${STAGE_ORDER}, u.level DESC, u.wins DESC
              LIMIT 50`, [g]);
        const names = await namesFor(req.botClient?.guilds.cache.get(g), rows.map(r => r.user_id));
        res.json({ success: true, tamers: rows.map(r => ({
            member: who(names, r.user_id), partner: r.nickname ? `${r.nickname} (${r.name})` : r.name, stage: r.stage,
            level: r.level, wins: r.wins, battles: r.battles, careMistakes: r.care_mistakes, owned: Number(r.owned), met: Number(r.met),
        })) });
    } catch (err) { fail(res, 'the leaderboard', err); }
});

router.get('/quiz', async (req, res) => {
    try {
        const g = req.params.guildId;
        const day = DAY.test(String(req.query.day || '')) ? req.query.day : quizDay();
        const [rows] = await pool.execute(
            `SELECT r.user_id, r.attribute, r.field, r.level AS power, r.crest, d.name, d.level AS stage
               FROM digimon_quiz_results r JOIN digimon_data d ON d.id = r.digimon_id
              WHERE r.guild_id = ? AND r.day = ? ORDER BY d.name`, [g, day]);
        const names = await namesFor(req.botClient?.guilds.cache.get(g), rows.map(r => r.user_id));
        const byDigimon = new Map(), attributes = {}, crests = {};
        for (const r of rows) {
            if (!byDigimon.has(r.name)) byDigimon.set(r.name, { name: r.name, stage: r.stage, members: [] });
            byDigimon.get(r.name).members.push(who(names, r.user_id));
            attributes[r.attribute] = (attributes[r.attribute] ?? 0) + 1;
            if (r.crest) crests[r.crest] = (crests[r.crest] ?? 0) + 1;
        }
        res.json({ success: true, day, takers: rows.length, attributes, crests,
            results: [...byDigimon.values()].sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name)) });
    } catch (err) { fail(res, 'quiz results', err); }
});

router.get('/market', async (req, res) => {
    try {
        const g = req.params.guildId;
        const [open] = await pool.execute(
            `SELECT m.id, m.seller_id, m.level, m.price, m.listed_at, d.name, d.level AS stage
               FROM digimon_market m JOIN digimon_data d ON d.id = m.digimon_id
              WHERE m.guild_id = ? AND m.status = 'open' ORDER BY m.listed_at DESC LIMIT 100`, [g]);
        const [sold] = await pool.execute(
            `SELECT m.id, m.seller_id, m.buyer_id, m.level, m.price, m.fee, m.closed_at, d.name
               FROM digimon_market m JOIN digimon_data d ON d.id = m.digimon_id
              WHERE m.guild_id = ? AND m.status = 'sold' ORDER BY m.closed_at DESC LIMIT 20`, [g]);
        const names = await namesFor(req.botClient?.guilds.cache.get(g), [...open, ...sold].flatMap(r => [r.seller_id, r.buyer_id]));
        res.json({ success: true,
            open: open.map(r => ({ id: r.id, seller: who(names, r.seller_id), name: r.name, stage: r.stage, level: r.level, price: r.price, listedAt: r.listed_at })),
            sold: sold.map(r => ({ id: r.id, seller: who(names, r.seller_id), buyer: who(names, r.buyer_id), name: r.name, level: r.level, price: r.price, fee: r.fee, soldAt: r.closed_at })) });
    } catch (err) { fail(res, 'the market', err); }
});

router.delete('/market/:listingId', async (req, res) => {
    try {
        const id = Number.parseInt(req.params.listingId, 10);
        const [[l]] = await pool.execute('SELECT guild_id FROM digimon_market WHERE id = ?', [id]);
        if (!l || l.guild_id !== req.params.guildId) return res.status(404).json({ success: false, error: 'No such listing in this server.' });
        const done = await cancelListing(id);
        if (!done) return res.status(409).json({ success: false, error: 'That listing is already closed.' });
        logger.info(`[DigimonAPI] Listing ${id} taken down in ${req.params.guildId} by ${req.user?.id}`);
        res.json({ success: true });
    } catch (err) { fail(res, 'the listing', err); }
});

/**
 * POST /reset  { userId }            one member: their Digimon, field guide, bits, meat and quiz results here
 * POST /reset  { all: true, confirm: 'RESET' }   everyone in this server, plus wild spawns
 * Open listings and trades involving them are closed first, so nothing points at a deleted Digimon.
 */
router.post('/reset', async (req, res) => {
    const g = req.params.guildId;
    const { userId, all, confirm } = req.body || {};
    if (all ? confirm !== 'RESET' : !SNOWFLAKE.test(String(userId || ''))) {
        return res.status(400).json({ success: false, error: all ? 'Type RESET to confirm.' : 'Pick a member to reset.' });
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const scope = all ? '' : ' AND user_id = ?';
        const p = all ? [g] : [g, userId];
        const counts = {};
        const run = async (key, sql, params) => { const [r] = await conn.execute(sql, params); counts[key] = r.affectedRows; };
        await run('listings', `UPDATE digimon_market SET status = 'cancelled', closed_at = NOW() WHERE guild_id = ? AND status = 'open'${all ? '' : ' AND seller_id = ?'}`, p);
        await run('trades', `UPDATE digimon_trades SET status = 'cancelled', finished_at = NOW() WHERE guild_id = ? AND status = 'open'${all ? '' : ' AND (from_user = ? OR to_user = ?)'}`, all ? [g] : [g, userId, userId]);
        await run('digimon', `DELETE FROM user_digimon WHERE guild_id = ?${scope}`, p);
        await run('dex', `DELETE FROM user_digimon_dex WHERE guild_id = ?${scope}`, p);
        await run('inventory', `DELETE FROM digimon_inventory WHERE guild_id = ?${scope}`, p);
        await run('quiz', `DELETE FROM digimon_quiz_results WHERE guild_id = ?${scope}`, p);
        if (all) await run('spawns', 'DELETE FROM digimon_spawns WHERE guild_id = ?', [g]);
        await conn.commit();
        logger.info(`[DigimonAPI] Reset ${all ? 'everyone' : userId} in ${g} by ${req.user?.id}`, counts);
        res.json({ success: true, counts });
    } catch (err) {
        await conn.rollback().catch(() => {});
        fail(res, 'the reset', err);
    } finally {
        conn.release();
    }
});

export default router;
