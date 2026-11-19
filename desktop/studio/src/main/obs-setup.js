'use strict';
/*
 * "Set up OBS for CertiFried": the opt-in changes behind the checklist. Each runs only on its own click.
 *
 *   installTheme({ srcDir, themesDir, now })   copy the three CertiFried Styles (.ovt) into OBS's themes folder
 *                                              (%APPDATA%\obs-studio\themes); a file of the same name that differs is
 *                                              kept as <name>.certifried-backup-<time>. Does not switch the theme.
 *   themeInstalled({ srcDir, themesDir })      true when every file is there and identical
 *   validateTheme(text)                        sanity check of an .ovt (meta block, ids, variable names)
 *   STARTER_SCENES / planStarterScenes(sceneNames)   which starter scenes do not exist yet
 *   createStarterScenes(obs, names)            obs-websocket CreateScene + a centred text source per scene; scenes
 *                                              that already exist are left alone
 */
const fs = require('node:fs');
const path = require('node:path');

const THEME_FILES = ['CertiFried.ovt', 'CertiFried_Light.ovt', 'CertiFried_Sand.ovt'];

function stamp(now) {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function themesDirFor(obsDir) { return path.join(obsDir, 'themes'); }

function validateTheme(text) {
    const t = String(text);
    const meta = t.match(/@OBSThemeMeta\s*\{([^}]*)\}/);
    if (!meta) return { ok: false, error: 'no @OBSThemeMeta block' };
    const field = (k) => (meta[1].match(new RegExp(`${k}:\\s*'([^']*)'\\s*;`)) || [])[1];
    for (const k of ['name', 'id', 'extends', 'author', 'dark']) if (!field(k)) return { ok: false, error: `meta ${k} missing` };
    const vars = t.match(/@OBSThemeVars\s*\{([^}]*)\}/);
    if (!vars) return { ok: false, error: 'no @OBSThemeVars block' };
    for (const line of vars[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('/*'))) {
        if (!/^--[A-Za-z0-9_]+:\s*[^;]+;$/.test(line)) return { ok: false, error: `bad variable line: ${line}` };
    }
    return { ok: true, id: field('id'), extends: field('extends'), name: field('name'), dark: field('dark') === 'true' };
}

function themeInstalled({ srcDir, themesDir }) {
    return THEME_FILES.every((f) => {
        try { return fs.readFileSync(path.join(themesDir, f)).equals(fs.readFileSync(path.join(srcDir, f))); } catch { return false; }
    });
}

function installTheme({ srcDir, themesDir, now = Date.now() }) {
    fs.mkdirSync(themesDir, { recursive: true });
    const copied = [];
    const backups = [];
    for (const f of THEME_FILES) {
        const src = fs.readFileSync(path.join(srcDir, f));
        const dst = path.join(themesDir, f);
        if (fs.existsSync(dst)) {
            if (fs.readFileSync(dst).equals(src)) { copied.push(f); continue; }
            const b = `${dst}.certifried-backup-${stamp(now)}`;
            fs.copyFileSync(dst, b, fs.constants.COPYFILE_EXCL);
            backups.push(path.basename(b));
        }
        const tmp = `${dst}.certifried-${process.pid}.tmp`;
        fs.writeFileSync(tmp, src);
        fs.renameSync(tmp, dst);
        copied.push(f);
    }
    return { themesDir, copied, backups };
}

const STARTER_SCENES = Object.freeze([
    { name: 'Starting Soon', text: 'Starting soon' },
    { name: 'Be Right Back', text: 'Be right back' },
    { name: 'Stream Ending', text: 'Thanks for watching' },
]);

function planStarterScenes(sceneNames = []) {
    const have = new Set(sceneNames.map((s) => String(s).toLowerCase()));
    return STARTER_SCENES.filter((s) => !have.has(s.name.toLowerCase()));
}

async function createStarterScenes(obs, names) {
    if (!obs?.connected) { const e = new Error('Connect OBS first.'); e.code = 'obs_not_connected'; throw e; }
    const wanted = STARTER_SCENES.filter((s) => names.includes(s.name));
    const list = await obs.call('GetSceneList');
    const existing = (list.scenes || []).map((s) => s.sceneName);
    const inputs = new Set(((await obs.call('GetInputList')).inputs || []).map((i) => i.inputName));
    const created = [];
    for (const s of planStarterScenes(existing).filter((x) => wanted.includes(x))) {
        await obs.call('CreateScene', { sceneName: s.name });
        let inputName = `${s.name} text`;
        for (let n = 2; inputs.has(inputName); n++) inputName = `${s.name} text ${n}`;
        await obs.call('CreateInput', {
            sceneName: s.name, inputName, inputKind: 'text_gdiplus_v3', sceneItemEnabled: true,
            inputSettings: { text: s.text, font: { face: 'Segoe UI', size: 96, style: 'Bold', flags: 1 }, align: 'center', valign: 'center', color: 0xffffffff },
        });
        inputs.add(inputName);
        created.push(s.name);
    }
    return { created };
}

module.exports = { THEME_FILES, themesDirFor, validateTheme, themeInstalled, installTheme, STARTER_SCENES, planStarterScenes, createStarterScenes };
