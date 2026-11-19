'use strict';
/*
 * "Add CertiFried docks to OBS": custom browser docks written into OBS's own config.
 *
 * Where OBS keeps them (checked in OBS's source, frontend/widgets/OBSBasic_Browser.cpp):
 *   OBS 31 and later   <user config>\obs-studio\user.ini   (normally %APPDATA%\obs-studio\user.ini; global.ini
 *                      [Locations] Configuration can move it)
 *   OBS 30             %APPDATA%\obs-studio\global.ini
 *   section [BasicWindow], key ExtraBrowserDocks = one line of JSON: [{ "title", "url", "uuid": "{…}" }]
 * obs-websocket cannot add docks, so the file is edited. OBS rewrites this file when it exits, so a change made while
 * OBS runs would be lost or would race it: Studio only writes while OBS is closed, after a timestamped backup next to
 * the file, keeps every other dock the person has, and replaces only its own (matched by URL path /stream/bot/dock/).
 *
 *   obsDir(env)                          %APPDATA%\obs-studio (CF_STUDIO_OBS_DIR for tests)
 *   locateDockConfig(dir)                → { file, kind: 'user.ini' | 'global.ini' }   throws not_found
 *   readDocks(file) / planDocks(existing, ours) / writeDocks({ file, docks, now })
 *   isObsRunning({ execFileSync })       true when obs64.exe / obs32.exe / obs.exe is running
 *   addDocks({ dir, docks, running, now }) → { file, kind, backup, added, kept }   throws obs_running, not_found
 *   iniGet(text, section, key) / iniSet(text, section, key, value)   line-based; everything else kept byte for byte
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const DOCK_PATH = /\/stream\/bot\/dock\//;

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

function obsDir(env = process.env) {
    return env.CF_STUDIO_OBS_DIR ? path.resolve(env.CF_STUDIO_OBS_DIR) : path.join(env.APPDATA || '', 'obs-studio');
}

function eolOf(text) { return /\r\n/.test(text) ? '\r\n' : '\n'; }

function iniGet(text, section, key) {
    let inSection = false;
    for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
        const line = raw.trim();
        const m = line.match(/^\[(.+)\]$/);
        if (m) { inSection = m[1] === section; continue; }
        if (!inSection) continue;
        const eq = raw.indexOf('=');
        if (eq > 0 && raw.slice(0, eq).trim() === key) return raw.slice(eq + 1);
    }
    return null;
}

function iniSet(text, section, key, value) {
    const bom = String(text).startsWith('﻿') ? '﻿' : '';
    const body = String(text).replace(/^﻿/, '');
    const eol = eolOf(body);
    const lines = body.length ? body.split(/\r?\n/) : [];
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].trim().match(/^\[(.+)\]$/);
        if (!m) continue;
        if (start >= 0) { end = i; break; }
        if (m[1] === section) start = i;
    }
    const entry = `${key}=${value}`;
    if (start < 0) {
        while (lines.length && lines[lines.length - 1] === '') lines.pop();
        if (lines.length) lines.push('');
        lines.push(`[${section}]`, entry, '');
        return bom + lines.join(eol);
    }
    for (let i = start + 1; i < end; i++) {
        const eq = lines[i].indexOf('=');
        if (eq > 0 && lines[i].slice(0, eq).trim() === key) {
            lines[i] = entry;
            return bom + lines.join(eol);
        }
    }
    // after the last non-empty line of the section
    let at = end;
    while (at - 1 > start && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, entry);
    return bom + lines.join(eol);
}

function locateDockConfig(dir) {
    const globalIni = path.join(dir, 'global.ini');
    let configRoot = null;
    try {
        const loc = iniGet(fs.readFileSync(globalIni, 'utf8'), 'Locations', 'Configuration');
        if (loc && loc.trim()) configRoot = loc.trim();
    } catch { /* no global.ini */ }
    const candidates = [];
    if (configRoot) candidates.push(path.join(configRoot, 'obs-studio', 'user.ini'));
    candidates.push(path.join(dir, 'user.ini'));
    for (const f of candidates) if (fs.existsSync(f)) return { file: f, kind: 'user.ini' };
    if (fs.existsSync(globalIni)) return { file: globalIni, kind: 'global.ini' };
    throw fail('not_found', 'OBS settings were not found on this PC. Open OBS once, close it, then try again.');
}

function readDocks(file) {
    const v = iniGet(fs.readFileSync(file, 'utf8'), 'BasicWindow', 'ExtraBrowserDocks');
    if (!v || !v.trim()) return [];
    try {
        const list = JSON.parse(v);
        return Array.isArray(list) ? list.filter((d) => d && typeof d === 'object') : [];
    } catch {
        throw fail('bad_format', 'OBS\'s list of custom docks could not be read, so it was left alone.');
    }
}

const newUuid = () => `{${crypto.randomUUID()}}`;

/** Keep the person's docks; replace ours (by URL path) with the new ones. */
function planDocks(existing, ours) {
    const kept = existing.filter((d) => !DOCK_PATH.test(String(d.url || '')));
    const replaced = existing.length - kept.length;
    const added = ours.map((d) => ({ title: String(d.title), url: String(d.url), uuid: newUuid() }));
    return { list: [...kept, ...added], kept: kept.length, replaced, added: added.length };
}

function stamp(now) {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeDocks({ file, docks, now = Date.now() }) {
    const before = fs.readFileSync(file);
    const backup = `${file}.certifried-backup-${stamp(now)}`;
    fs.writeFileSync(backup, before, { flag: 'wx' });          // never overwrite an earlier backup
    const existing = readDocks(file);
    const plan = planDocks(existing, docks);
    const text = iniSet(before.toString('utf8'), 'BasicWindow', 'ExtraBrowserDocks', JSON.stringify(plan.list));
    const tmp = `${file}.certifried-${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return { backup, ...plan };
}

function isObsRunning({ execFileSync = childProcess.execFileSync } = {}) {
    try {
        const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        return /^"(obs64|obs32|obs)\.exe"/im.test(out);
    } catch {
        return true;   // cannot tell: act as if it is running, so nothing is written
    }
}

function addDocks({ dir, docks, running, now = Date.now() }) {
    if (running) throw fail('obs_running', 'Close OBS first. OBS saves this list when it closes, so a change made while it runs would be lost.');
    for (const d of docks) {
        const u = new URL(d.url);
        if (!['https:', 'http:'].includes(u.protocol) || !DOCK_PATH.test(u.pathname)) throw fail('bad_params', 'not a CertiFried dock address');
    }
    const where = locateDockConfig(dir);
    const r = writeDocks({ file: where.file, docks, now });
    return { file: where.file, kind: where.kind, backup: r.backup, added: r.added, kept: r.kept, replaced: r.replaced };
}

/**
 * The basic.ini of the OBS profile called `profileName` (the folder name can differ from the profile name, so it is
 * found by its [General] Name). Profiles live in <config>\obs-studio\basic\profiles; global.ini [Locations] Profiles
 * can move them.
 */
function findProfileIni(dir, profileName) {
    const roots = [];
    try {
        const loc = iniGet(fs.readFileSync(path.join(dir, 'global.ini'), 'utf8'), 'Locations', 'Profiles');
        if (loc && loc.trim()) roots.push(path.join(loc.trim(), 'obs-studio', 'basic', 'profiles'));
    } catch { /* default only */ }
    roots.push(path.join(dir, 'basic', 'profiles'));
    for (const root of roots) {
        let entries = [];
        try { entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
        for (const e of entries) {
            const ini = path.join(root, e.name, 'basic.ini');
            try {
                if ((iniGet(fs.readFileSync(ini, 'utf8'), 'General', 'Name') || '').trim() === profileName) return ini;
            } catch { /* not a profile */ }
        }
    }
    return null;
}

/** Copy the profile's basic.ini next to itself before Studio changes a profile setting. → backup file name, or null. */
function backupProfileIni({ dir, profileName, now = Date.now() }) {
    const ini = findProfileIni(dir, profileName);
    if (!ini) return null;
    const backup = `${ini}.certifried-backup-${stamp(now)}`;
    if (!fs.existsSync(backup)) fs.copyFileSync(ini, backup, fs.constants.COPYFILE_EXCL);
    return path.basename(backup);
}

module.exports = { obsDir, locateDockConfig, readDocks, planDocks, writeDocks, isObsRunning, addDocks, iniGet, iniSet, findProfileIni, backupProfileIni, DOCK_PATH };
