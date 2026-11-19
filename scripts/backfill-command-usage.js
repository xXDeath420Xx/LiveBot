/*
 * One-off backfill of command_usage_daily (migration 433) from what is still on disk.
 *
 *   node scripts/backfill-command-usage.js            dry run: reads everything, writes nothing, prints counts
 *   node scripts/backfill-command-usage.js --apply    writes the daily rows
 *
 * Sources, each written with its own `source` value so it never mixes with live tracking:
 *   backfill_audit    slash commands and context menus from audit_logs (event_type COMMAND_USAGE, written
 *                     for every slash command used in a server since 2025-12; audit_logs keeps 365 days).
 *                     The path is the command plus the subcommand or group the row's options name.
 *   backfill_log      slash commands used in DMs, from the bot's log files ("[Command] [<bot>] <user>
 *                     executed /<name>"); server uses in the logs are the same events audit_logs already
 *                     has, so they are only compared, not added.
 *   backfill_message  chat commands from message_logs (only deleted or edited messages are kept there,
 *                     90 days): a message counts only when it starts with one of that server's prefixes and
 *                     its first word resolves to one of OUR commands (the hand-written registry or the slash
 *                     bridge). Commands that other bots also answer with the same prefix (Dyno ?ban, MEE6
 *                     !rank, music bots !play ...) cannot be told apart and are left out (OTHER_BOT_WORDS).
 *
 * Only events before live tracking began (the first command_usage row, or now) are counted, so the
 * backfill never overlaps live numbers. Re-running gives the same rows (upsert on the daily key).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { Collection } from 'discord.js';
import pool from '../utils/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
// Synchronous writes: output piped to another program must not be lost at process.exit().
const say = (...a) => fs.writeSync(1, a.join(' ') + '\n');

// Words other popular bots answer on the same prefixes. A deleted "?ban" is far more often Dyno's than ours.
const OTHER_BOT_WORDS = new Set(['ban', 'unban', 'kick', 'warn', 'warnings', 'mute', 'unmute', 'timeout', 'purge', 'clear',
    'clean', 'lock', 'unlock', 'slowmode', 'whois', 'userinfo', 'serverinfo', 'help', 'rank', 'level', 'levels', 'play', 'p',
    'skip', 's', 'queue', 'q', 'stop', 'np', 'daily', 'bal', 'balance', 'work', 'bump', 'vote', 'poll', 'role', 'say', 'avatar',
    'sr', 'so', 'time', 'date', 'remind', 'note', 'tag', 'afk', 'ping', 'stats', 'top', 'leaderboard', 'lb', 'shop', 'use']);
const HISTORIC_PREFIXES = ['!', '?', '$', '.'];   // "/" was not a chat prefix before the 2026-11-18 split

async function loadCommands() {
    const commands = new Collection();
    for (const folder of fs.readdirSync(path.join(ROOT, 'commands'))) {
        const dir = path.join(ROOT, 'commands', folder);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
            try {
                const c = (await import(`file://${path.join(dir, f)}`)).default;
                if (c?.data && c.execute) commands.set(c.data.name, c);
            } catch { /* a module that does not load cannot have been used either */ }
        }
    }
    return commands;
}

async function tableExists(name) {
    const [r] = await pool.query('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]);
    return r.length > 0;
}

/** day|guild|path|kind -> { uses, users:Set } */
function bucket() {
    const m = new Map();
    return {
        add(day, guild, p, kind, user) {
            const k = `${day}|${guild}|${p}|${kind}`;
            let b = m.get(k);
            if (!b) { b = { day, guild, path: p, kind, uses: 0, users: new Set() }; m.set(k, b); }
            b.uses++;
            if (user) b.users.add(user);
        },
        rows: () => [...m.values()],
    };
}

function ymd(d) {
    const x = d instanceof Date ? d : new Date(d);
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

// ── (a) audit_logs ─────────────────────────────────────────────────────────
async function fromAudit(commands, cutoff) {
    const shape = new Map();
    for (const [name, c] of commands) {
        const j = c.data.toJSON();
        const subs = new Set(), groups = new Set();
        for (const o of j.options ?? []) { if (o.type === 1) subs.add(o.name); if (o.type === 2) groups.add(o.name); }
        shape.set(name, { subs, groups });
    }
    const [rows] = await pool.query(
        `SELECT timestamp, guild_id, user_id, action, metadata FROM audit_logs
          WHERE event_type = 'COMMAND_USAGE' AND timestamp < ? ORDER BY id`, [cutoff]);
    const b = bucket();
    let partial = 0, removed = 0;
    for (const r of rows) {
        const action = String(r.action || '');
        const day = ymd(r.timestamp);
        const menu = /^\[(user|message) menu\]\s*(.+)$/.exec(action);
        if (menu) { b.add(day, r.guild_id || '', menu[2].trim().toLowerCase().slice(0, 100), 'context', r.user_id); continue; }
        if (!action.startsWith('/')) continue;
        const top = action.slice(1).trim().toLowerCase();
        if (!top) continue;
        let p = top;
        const s = shape.get(top);
        if (!s) removed++;
        let meta = null;
        try { meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata; } catch { meta = null; }
        const first = Array.isArray(meta?.options) && meta.options[0] && meta.options[0].value === undefined ? String(meta.options[0].name).toLowerCase() : null;
        if (s && first && (s.subs.has(first) || s.groups.has(first))) {
            p = `${top} ${first}`;
            if (s.groups.has(first)) partial++;   // the subcommand inside a group was not recorded
        }
        b.add(day, r.guild_id || '', p.slice(0, 100), 'slash', r.user_id);
    }
    return { rows: b.rows(), read: rows.length, partial, removed };
}

// ── (b) log files ──────────────────────────────────────────────────────────
function logFiles() {
    const out = [];
    const pm2 = path.join(os.homedir(), '.pm2', 'logs');
    if (fs.existsSync(pm2)) for (const f of fs.readdirSync(pm2)) if (/^CertiFriedUtility-out.*\.log$/.test(f)) out.push(path.join(pm2, f));
    const logs = path.join(ROOT, 'logs');
    if (fs.existsSync(logs)) for (const f of fs.readdirSync(logs)) if (/^combined-.*\.log(\.\d+)?$/.test(f)) out.push(path.join(logs, f));
    return out;
}

const ANSI = /\x1b\[[0-9;]*m/g;
// Three line shapes are on disk: the old console format (coloured, context on the following lines), the
// app log ("[2026-11-15 15:34:10.968] [INFO] [Command] ... | User: <id> | Context: {...}") and the pm2 log
// of the same with a "2026-11-18T00:00:02: " prefix. Milliseconds are dropped so both copies match.
const HEAD = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)?\]\s*(?:\[\w+\]|\w+)\s+\[Command\] \[([^\]]+)\] (.+?) executed \/(\S+)/;
const STAMP = /^(?:\S+: )?\[\d{4}-\d{2}-\d{2} /;

/** Every "executed /" event in one file, with its guildId/userId (inline Context, or the lines after it). */
async function scanFile(file, onEvent) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let cur = null, ctx = 0;
    for await (const raw of rl) {
        if (cur) {
            const line = raw.replace(ANSI, '');
            const kv = /^\s+(guildId|userId):\s*(\d+)/.exec(line);
            if (kv) cur[kv[1]] = kv[2];
            if (++ctx > 8 || STAMP.test(line)) { onEvent(cur); cur = null; }
            else continue;
        }
        if (!raw.includes('executed /')) continue;
        const line = raw.replace(ANSI, '');
        const head = HEAD.exec(line);
        if (!head) continue;
        const e = { ts: head[1], bot: head[2], user: head[3], name: head[4].toLowerCase(), guildId: null, userId: null };
        const user = /\| User: (\d+)/.exec(line);
        if (user || line.includes('| Context:')) {
            e.userId = user?.[1] ?? null;
            e.guildId = /"guildId":"(\d+)"/.exec(line)?.[1] ?? null;
            onEvent(e);
        } else {
            cur = e; ctx = 0;
        }
    }
    if (cur) onEvent(cur);
}

async function fromLogs(cutoff) {
    const files = logFiles();
    const seen = new Set();
    const b = bucket();
    const guildPerDay = new Map();
    for (const file of files) {
        await scanFile(file, (e) => {
            // The same line is in the pm2 log and the app log: count each event once.
            const key = `${e.ts}|${e.user}|${e.name}|${e.bot}`;
            if (seen.has(key) || !(new Date(e.ts.replace(' ', 'T')) < cutoff)) return;
            seen.add(key);
            const day = e.ts.slice(0, 10);
            if (e.guildId) guildPerDay.set(day, (guildPerDay.get(day) || 0) + 1);
            else b.add(day, '', e.name, 'slash', e.userId || e.user);
        });
    }
    return { rows: b.rows(), events: seen.size, files: files.length, guildPerDay };
}

// ── (c) message_logs ───────────────────────────────────────────────────────
async function fromMessages(commands, cutoff) {
    const uc = await import('../core/universal-commands.js');
    const { getCommand } = await import('../core/prefix-command-registry.js');
    uc.buildIndex({ commands });
    const [cfgRows] = await pool.query('SELECT guild_id, prefix, prefixes, universal_commands, enabled FROM prefix_command_config');
    const cfg = new Map(cfgRows.map(r => [r.guild_id, r]));
    const [aliasRows] = await pool.query('SELECT guild_id, alias, command_name FROM prefix_command_aliases');
    const aliases = new Map();
    for (const a of aliasRows) aliases.set(`${a.guild_id}|${a.alias.toLowerCase()}`, a.command_name.toLowerCase());
    const [rows] = await pool.query(
        `SELECT guild_id, author_id, content, timestamp FROM message_logs
          WHERE content REGEXP '^[!?$.#%&*+,:;=~^-]' AND timestamp < ?`, [cutoff]);
    const b = bucket();
    let candidates = 0, ours = 0, excluded = 0;
    for (const r of rows) {
        const c = cfg.get(r.guild_id);
        if (c && c.enabled === 0) continue;
        let list = HISTORIC_PREFIXES;
        try { const j = c?.prefixes ? JSON.parse(c.prefixes) : null; if (Array.isArray(j) && j.length) list = j; } catch { /* default list */ }
        const prefixes = [...new Set([c?.prefix || '!', ...list])].filter(p => p && p !== '/').sort((a, x) => x.length - a.length);
        const content = String(r.content || '').trimStart();
        const prefix = prefixes.find(p => content.startsWith(p) && /^[a-z]/i.test(content.slice(p.length)));
        if (!prefix) continue;
        candidates++;
        const tokens = content.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
        const typed = tokens[0].toLowerCase();
        const first = aliases.get(`${r.guild_id}|${typed}`) || typed;
        let p = null;
        const legacy = getCommand(first);
        if (legacy) {
            const canonical = legacy.canonicalName || first;
            const hit = uc.resolve([canonical]);
            p = hit?.entry ? hit.path : canonical;
        } else if (c?.universal_commands !== 0) {
            const hit = uc.resolve([...first.split(' '), ...tokens.slice(1)]);
            if (hit?.entry) p = hit.path;
        }
        if (!p) continue;
        if (OTHER_BOT_WORDS.has(typed)) { excluded++; continue; }
        ours++;
        b.add(ymd(r.timestamp), r.guild_id, p.slice(0, 100), 'prefix', r.author_id);
    }
    return { rows: b.rows(), read: rows.length, candidates, ours, excluded };
}

async function write(rows, source) {
    if (!rows.length) return 0;
    const values = rows.map(r => [r.day, r.guild, r.path, r.kind, source, r.uses, r.users.size, 0]);
    let n = 0;
    for (let i = 0; i < values.length; i += 500) {
        const [res] = await pool.query(
            `INSERT INTO command_usage_daily (day, guild_id, path, kind, source, uses, unique_users, errors) VALUES ?
             ON DUPLICATE KEY UPDATE uses = VALUES(uses), unique_users = VALUES(unique_users)`, [values.slice(i, i + 500)]);
        n += res.affectedRows;
    }
    return n;
}

const sum = (rows) => rows.reduce((s, r) => s + r.uses, 0);

try {
    const haveDaily = await tableExists('command_usage_daily');
    if (APPLY && !haveDaily) throw new Error('command_usage_daily does not exist yet: run migration 433 first');
    let cutoff = new Date();
    if (await tableExists('command_usage')) {
        const [[m]] = await pool.query('SELECT MIN(created_at) AS first FROM command_usage');
        if (m.first) cutoff = new Date(m.first);
    }
    say(`${APPLY ? 'APPLY' : 'DRY RUN'}: counting events before ${cutoff.toISOString()} (start of live tracking)`);
    const commands = await loadCommands();

    const a = await fromAudit(commands, cutoff);
    const aDays = new Set(a.rows.map(r => r.day));
    say(`audit_logs: ${a.read} COMMAND_USAGE rows -> ${a.rows.length} daily rows, ${sum(a.rows)} uses `
        + `(${sum(a.rows.filter(r => r.kind === 'slash'))} slash, ${sum(a.rows.filter(r => r.kind === 'context'))} context menu) `
        + `over ${aDays.size} days from ${[...aDays].sort()[0] || '-'}; ${a.partial} name only a group (subcommand not recorded); `
        + `${a.removed} are commands that no longer exist`);

    const l = await fromLogs(cutoff);
    const auditPerDay = new Map();
    for (const r of a.rows) if (r.kind === 'slash') auditPerDay.set(r.day, (auditPerDay.get(r.day) || 0) + r.uses);
    const cmp = [...l.guildPerDay.entries()].sort().map(([d, n]) => `${d} log ${n} / audit ${auditPerDay.get(d) || 0}`);
    say(`log files: ${l.files} files, ${l.events} distinct "executed /" events; server uses per day (log vs audit_logs, the same events): ${cmp.join('; ') || 'none'}`);
    say(`log files: ${sum(l.rows)} DM uses not in audit_logs -> ${l.rows.length} daily rows`);

    const m = await fromMessages(commands, cutoff);
    say(`message_logs: ${m.read} prefix-looking messages, ${m.candidates} start with a server prefix, ${m.ours + m.excluded} resolve to our commands, `
        + `${m.excluded} left out as other bots' words, ${m.ours} counted -> ${m.rows.length} daily rows`);

    if (APPLY) {
        const wa = await write(a.rows, 'backfill_audit');
        const wl = await write(l.rows, 'backfill_log');
        const wm = await write(m.rows, 'backfill_message');
        say(`written: audit ${wa}, log ${wl}, message ${wm} (affected rows)`);
    } else {
        say('dry run: nothing written. Re-run with --apply after migration 433.');
    }
} catch (err) {
    fs.writeSync(2, `backfill failed: ${err.message}\n`);
    process.exitCode = 1;
}
process.exit(process.exitCode || 0);
