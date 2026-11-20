'use strict';
/*
 * Voicemeeter (VB-Audio) through its Remote API, VoicemeeterRemote64.dll, loaded with koffi.
 *
 *   const vm = createVoicemeeter({ logger, binding?, locate?, loadBinding?, record?, documentsDir, enabled? })
 *     configure({ enabled })   off by default. Turning it on logs in; turning it off logs out and unloads. Nothing is
 *                              loaded until it is turned on, or detect() is called (the Detect button).
 *     detect()                 → { installed, dllPath, running, type: 'basic'|'banana'|'potato'|null, version,
 *                                  strips: [{ index, label, name, isVirtual }], buses: [{ index, label, name }],
 *                                  macroButtons: bool, profiles: [file names] }
 *                              Works while turned off (logs in for the read, then out again and unloads).
 *     run(action, params)      one of VOICEMEETER_ACTIONS; resolves with the result or throws Error with .code
 *     handlers()               { 'voicemeeter.mute': fn(params), ... } for the router's `extra`
 *     status()                 { enabled, loaded, loggedIn, dllPath }
 *     close()                  logs out and unloads
 *
 * Actions:
 *   voicemeeter.mute    { target: 'strip:<i>'|'bus:<i>', state: 'mute'|'unmute'|'toggle' }              → { target, muted }
 *   voicemeeter.gain    { target, mode: 'set'|'adjust', gain (set -60..12 dB, adjust -72..72), fadeMs 0-5000 } → { target, gain }
 *                       fadeMs > 0 sends `Strip[i].FadeTo = (dB, ms);` (or Bus[i]) through VBVMR_SetParameters
 *   voicemeeter.profile { profile: '<file name>.xml' }  only files directly in <documentsDir>\Voicemeeter\ → { profile }
 *   voicemeeter.macro   { button 0-79, state: 'press'|'on'|'off'|'toggle' }                             → { button, on }
 *                       press = push then release (VBVMR_MACROBUTTON_MODE_DEFAULT, value 1 then 0), like a click
 * Errors (Error.code): voicemeeter_off, voicemeeter_not_installed, voicemeeter_not_running, bad_target, bad_params,
 *   profile_not_found, macro_unavailable, voicemeeter_error (+ message).
 *
 * The binding is a thin object over the DLL; everything above it is plain JavaScript, so tests and the device sandbox
 * use fakeVoicemeeterBinding() and never load the real DLL. Binding methods (return codes are the DLL's own):
 *   login() → rc (0 ok, 1 installed but Voicemeeter not running, -2 already logged in, -1 error)   logout() → rc
 *   getType() → { rc, value }  (1 basic, 2 banana, 3 potato; rc -2 = Voicemeeter not running)
 *   getVersion() → { rc, value }  (packed v1.v2.v3.v4, one byte each, v1 highest)
 *   isParametersDirty() → rc (called before reads so the values are current)
 *   getFloat(name) → { rc, value }      getString(name) → { rc, value }      setFloat(name, value) → rc
 *   setParameters(script) → rc (>0 = the script line in error)
 *   hasMacro: bool; macroIsDirty() → rc; macroGetStatus(button, mode) → { rc, value }; macroSetStatus(button, value, mode) → rc
 *   unload()
 *
 * The DLL is found from the uninstall key (read with `reg query`, no shell; never written) and then the default install
 * folder. Voicemeeter is never started from here: when it is not running, actions answer voicemeeter_not_running.
 */
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const VOICEMEETER_ACTIONS = ['voicemeeter.mute', 'voicemeeter.gain', 'voicemeeter.profile', 'voicemeeter.macro'];
const UNINSTALL_KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VB:Voicemeeter {17359A74-1236-5467}';
const DEFAULT_DIR = 'C:\\Program Files (x86)\\VB\\Voicemeeter';
const DLL_NAME = 'VoicemeeterRemote64.dll';

// Strip and bus layout per type: hardware strips first, then virtual ones.
const TYPES = {
    1: { type: 'basic', hwStrips: 2, strips: 3, buses: ['A', 'B'] },
    2: { type: 'banana', hwStrips: 3, strips: 5, buses: ['A1', 'A2', 'A3', 'B1', 'B2'] },
    3: { type: 'potato', hwStrips: 5, strips: 8, buses: ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3'] },
};
const MACRO_MODE_DEFAULT = 0;       // VBVMR_MACROBUTTON_MODE_DEFAULT: push or release, as a click would
const MACRO_BUTTONS = 80;
const GAIN_MIN = -60;
const GAIN_MAX = 12;
const TARGET_RE = /^(strip|bus):(\d{1,2})$/;
const PROFILE_BAD = /[\\/:*?"<>|\x00-\x1f]/;

function fail(code, message) { const e = new Error(message || code); e.code = code; return e; }
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round1 = (n) => Math.round(n * 10) / 10;

function versionString(v) {
    const n = Number(v) >>> 0;
    if (!n) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

function execFileText(file, args) {
    return new Promise((resolve, reject) => {
        childProcess.execFile(file, args, { windowsHide: true, timeout: 5000, shell: false }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    });
}

/** Find VoicemeeterRemote64.dll. Resolves with the full path or null. Reads the registry only. */
async function locateVoicemeeterDll({ run = execFileText, exists = fs.existsSync, platform = process.platform, env = process.env } = {}) {
    if (platform !== 'win32') return null;
    const dirs = [];
    try {
        const reg = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
        const dir = uninstallDir(await run(reg, ['query', UNINSTALL_KEY, '/v', 'UninstallString']));
        if (dir) dirs.push(dir);
    } catch { /* no key: not installed with the official installer; try the default folder */ }
    dirs.push(DEFAULT_DIR);
    for (const d of dirs) {
        const p = path.win32.join(d, DLL_NAME);
        try { if (exists(p)) return p; } catch { /* ignore */ }
    }
    return null;
}

/** The folder of the UninstallString value in `reg query` output, or null. */
function uninstallDir(regOutput) {
    const m = String(regOutput || '').match(/UninstallString\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
    if (!m) return null;
    let v = m[1].trim();
    if (v.startsWith('"')) {
        const end = v.indexOf('"', 1);
        v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
        const exe = v.match(/^(.+?\.exe)(?=\s|$)/i);
        if (exe) v = exe[1];
    }
    if (!/^[A-Za-z]:\\/.test(v)) return null;
    return path.win32.dirname(v);
}

/** Load the real DLL with koffi. Only called when the person turns Voicemeeter on or clicks Detect. */
function loadVoicemeeterDll(dllPath, { koffi = require('koffi') } = {}) {
    const lib = koffi.load(dllPath);
    const fn = (proto) => lib.func(proto);
    const Login = fn('int32_t __stdcall VBVMR_Login()');
    const Logout = fn('int32_t __stdcall VBVMR_Logout()');
    const GetType = fn('int32_t __stdcall VBVMR_GetVoicemeeterType(_Out_ int32_t *pType)');
    const GetVersion = fn('int32_t __stdcall VBVMR_GetVoicemeeterVersion(_Out_ int32_t *pVersion)');
    const IsDirty = fn('int32_t __stdcall VBVMR_IsParametersDirty()');
    const GetFloat = fn('int32_t __stdcall VBVMR_GetParameterFloat(const char *szParamName, _Out_ float *pValue)');
    const GetStringW = fn('int32_t __stdcall VBVMR_GetParameterStringW(const char *szParamName, _Out_ uint8_t *wszString)');
    const SetFloat = fn('int32_t __stdcall VBVMR_SetParameterFloat(const char *szParamName, float value)');
    const SetParams = fn('int32_t __stdcall VBVMR_SetParameters(const char *szParamScript)');
    let SetParamsW = null;
    try { SetParamsW = fn('int32_t __stdcall VBVMR_SetParametersW(const char16_t *szParamScript)'); } catch { /* older DLL */ }
    let macro = null;
    try {
        macro = {
            isDirty: fn('int32_t __stdcall VBVMR_MacroButton_IsDirty()'),
            get: fn('int32_t __stdcall VBVMR_MacroButton_GetStatus(int32_t nuLogicalButton, _Out_ float *pValue, int32_t bitmode)'),
            set: fn('int32_t __stdcall VBVMR_MacroButton_SetStatus(int32_t nuLogicalButton, float fValue, int32_t bitmode)'),
        };
    } catch { macro = null; /* a DLL from before macro buttons */ }

    const withOut = (call) => { const o = [0]; const rc = call(o); return { rc, value: o[0] }; };
    return {
        login: () => Login(),
        logout: () => Logout(),
        getType: () => withOut((o) => GetType(o)),
        getVersion: () => withOut((o) => GetVersion(o)),
        isParametersDirty: () => IsDirty(),
        getFloat: (name) => withOut((o) => GetFloat(name, o)),
        getString(name) {
            const buf = Buffer.alloc(1024);          // 512 wide characters, as the API documents
            const rc = GetStringW(name, buf);
            let s = buf.toString('utf16le');
            const z = s.indexOf('\0');
            if (z >= 0) s = s.slice(0, z);
            return { rc, value: s };
        },
        setFloat: (name, value) => SetFloat(name, value),
        // Non-ASCII text (a profile path under a non-English user name) goes through the wide version.
        setParameters: (script) => (SetParamsW && /[^\x20-\x7e]/.test(script) ? SetParamsW(script) : SetParams(script)),
        hasMacro: !!macro,
        macroIsDirty: () => (macro ? macro.isDirty() : -1),
        macroGetStatus: (button, mode) => (macro ? withOut((o) => macro.get(button, o, mode)) : { rc: -1, value: 0 }),
        macroSetStatus: (button, value, mode) => (macro ? macro.set(button, value, mode) : -1),
        unload: () => { try { lib.unload(); } catch { /* ignore */ } },
    };
}

function createVoicemeeter({
    logger = null, binding = null, locate = locateVoicemeeterDll, loadBinding = loadVoicemeeterDll,
    record = null, documentsDir = null, enabled = false, readdir = (d) => fs.readdirSync(d, { withFileTypes: true }),
} = {}) {
    let on = !!enabled;
    let vm = binding;            // the binding in use (injected, or loaded from the DLL on demand)
    const injected = !!binding;
    let dllPath = null;
    let loggedIn = false;
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[voicemeeter] ${m}`, meta); } catch { /* ignore */ } };
    const note = (entry) => {
        try {
            if (typeof record === 'function') record({ kind: 'voicemeeter', ...entry });
            else if (Array.isArray(record)) record.push({ kind: 'voicemeeter', ...entry });
        } catch { /* recording is best effort */ }
    };

    async function load() {
        if (vm) return vm;
        if (!dllPath) dllPath = await locate();
        if (!dllPath) throw fail('voicemeeter_not_installed', 'VoicemeeterRemote64.dll was not found');
        try {
            vm = loadBinding(dllPath);
        } catch (e) {
            log('warn', 'could not load the Remote API', { message: e?.message });
            throw fail('voicemeeter_not_installed', 'the Voicemeeter Remote API could not be loaded');
        }
        return vm;
    }

    function login() {
        if (loggedIn) return;
        const rc = vm.login();
        // 1: installed but not running (calls answer -2 until it starts); -2: already logged in.
        if (rc === 0 || rc === 1 || rc === -2) { loggedIn = true; return; }
        throw fail('voicemeeter_error', `login failed (${rc})`);
    }

    function unload() {
        if (vm && loggedIn) { try { vm.logout(); } catch { /* ignore */ } }
        loggedIn = false;
        if (vm && !injected) { try { vm.unload?.(); } catch { /* ignore */ } vm = null; }
    }

    /** Voicemeeter's layout for its running type; throws voicemeeter_not_running. */
    function layout() {
        const t = vm.getType();
        if (t.rc === -2 || t.rc === -1) throw fail('voicemeeter_not_running', 'Voicemeeter is not running');
        if (t.rc !== 0) throw fail('voicemeeter_error', `type (${t.rc})`);
        const l = TYPES[t.value];
        if (!l) throw fail('voicemeeter_error', `unknown Voicemeeter type ${t.value}`);
        return l;
    }

    function refresh() {
        if (vm.isParametersDirty() === -2) throw fail('voicemeeter_not_running', 'Voicemeeter is not running');
    }

    function check(rc, what) {
        if (rc === 0) return;
        if (rc === -2) throw fail('voicemeeter_not_running', 'Voicemeeter is not running');
        if (rc === -3) throw fail('bad_target', `${what} is not available in this Voicemeeter`);
        throw fail('voicemeeter_error', `${what} (${rc})`);
    }

    function parseTarget(target, l) {
        const m = String(target ?? '').trim().toLowerCase().match(TARGET_RE);
        if (!m) throw fail('bad_target', 'target is strip:<n> or bus:<n>');
        const i = Number(m[2]);
        const count = m[1] === 'strip' ? l.strips : l.buses.length;
        if (i >= count) throw fail('bad_target', `${m[1]} ${i} does not exist in Voicemeeter ${l.type}`);
        return { index: i, param: `${m[1] === 'strip' ? 'Strip' : 'Bus'}[${i}]`, id: `${m[1]}:${i}` };
    }

    function listProfiles() {
        if (!documentsDir) return [];
        try {
            return readdir(path.join(documentsDir, 'Voicemeeter'))
                .filter((d) => typeof d === 'string' || d.isFile())
                .map((d) => (typeof d === 'string' ? d : d.name))
                .filter((n) => /\.xml$/i.test(n))
                .sort((a, b) => a.localeCompare(b))
                .slice(0, 200);
        } catch { return []; }
    }

    async function ready() {
        if (!on) throw fail('voicemeeter_off', 'Voicemeeter is turned off in Studio');
        await load();
        login();
        return layout();
    }

    // ---- actions --------------------------------------------------------------------------------------------------
    async function mute(p) {
        const l = await ready();
        const t = parseTarget(p.target, l);
        const state = String(p.state ?? 'toggle');
        if (!['mute', 'unmute', 'toggle'].includes(state)) throw fail('bad_params', 'state is mute, unmute or toggle');
        let muted;
        if (state === 'toggle') {
            refresh();
            const r = vm.getFloat(`${t.param}.Mute`);
            check(r.rc, `${t.id} mute`);
            muted = !(r.value >= 0.5);
        } else muted = state === 'mute';
        check(vm.setFloat(`${t.param}.Mute`, muted ? 1 : 0), `${t.id} mute`);
        return { target: t.id, muted };
    }

    async function gain(p) {
        const l = await ready();
        const t = parseTarget(p.target, l);
        const mode = String(p.mode ?? 'set');
        if (mode !== 'set' && mode !== 'adjust') throw fail('bad_params', 'mode is set or adjust');
        const g = Number(p.gain);
        if (p.gain === '' || p.gain == null || !Number.isFinite(g)) throw fail('bad_params', 'gain is a number of dB');
        const fadeMs = clamp(Math.round(Number(p.fadeMs) || 0), 0, 5000);
        let target;
        if (mode === 'adjust') {
            refresh();
            const r = vm.getFloat(`${t.param}.Gain`);
            check(r.rc, `${t.id} gain`);
            target = clamp(r.value + clamp(g, -72, 72), GAIN_MIN, GAIN_MAX);
        } else target = clamp(g, GAIN_MIN, GAIN_MAX);
        target = round1(target);
        if (fadeMs > 0) {
            const rc = vm.setParameters(`${t.param}.FadeTo = (${target.toFixed(1)}, ${fadeMs});`);
            if (rc > 0) throw fail('voicemeeter_error', 'Voicemeeter refused the fade');
            check(rc, `${t.id} fade`);
        } else check(vm.setFloat(`${t.param}.Gain`, target), `${t.id} gain`);
        return { target: t.id, gain: target };
    }

    async function profile(p) {
        if (!on) throw fail('voicemeeter_off', 'Voicemeeter is turned off in Studio');
        const name = String(p.profile ?? '').trim();
        if (!name || name.length > 200 || name.includes('..') || PROFILE_BAD.test(name) || !/\.xml$/i.test(name)) {
            throw fail('profile_not_found', 'a profile is a .xml file name from Documents\\Voicemeeter');
        }
        // The file exactly as listed (Windows names ignore case), never a path built from the request alone.
        const file = listProfiles().find((n) => n.toLowerCase() === name.toLowerCase());
        if (!file) throw fail('profile_not_found', `${name} is not in Documents\\Voicemeeter`);
        const full = path.join(documentsDir, 'Voicemeeter', file);
        await ready();
        const rc = vm.setParameters(`Command.Load = "${full}";`);
        if (rc > 0) throw fail('voicemeeter_error', 'Voicemeeter refused the profile');
        check(rc, 'profile');
        return { profile: file };
    }

    async function macro(p) {
        await ready();
        const button = Number(p.button);
        if (p.button === '' || p.button == null || !Number.isInteger(button) || button < 0 || button >= MACRO_BUTTONS) {
            throw fail('bad_target', 'button is 0 to 79');
        }
        const state = String(p.state ?? 'press');
        if (!['press', 'on', 'off', 'toggle'].includes(state)) throw fail('bad_params', 'state is press, on, off or toggle');
        if (!vm.hasMacro) throw fail('macro_unavailable', 'this Voicemeeter has no macro buttons');
        const set = (v) => {
            const rc = vm.macroSetStatus(button, v, MACRO_MODE_DEFAULT);
            if (rc === -3) throw fail('bad_target', `button ${button} does not exist`);
            if (rc !== 0) throw fail('macro_unavailable', `macro button (${rc})`);
        };
        let onNow;
        if (state === 'press') {
            set(1); set(0); onNow = false;
        } else if (state === 'toggle') {
            vm.macroIsDirty();
            const r = vm.macroGetStatus(button, MACRO_MODE_DEFAULT);
            if (r.rc !== 0) throw fail('macro_unavailable', `macro button (${r.rc})`);
            onNow = !(r.value >= 0.5);
            set(onNow ? 1 : 0);
        } else {
            onNow = state === 'on';
            set(onNow ? 1 : 0);
        }
        return { button, on: onNow };
    }

    const ACTIONS = { 'voicemeeter.mute': mute, 'voicemeeter.gain': gain, 'voicemeeter.profile': profile, 'voicemeeter.macro': macro };

    async function run(action, params = {}) {
        const fn = ACTIONS[action];
        if (!fn) throw fail('unsupported_action');
        const p = params && typeof params === 'object' ? params : {};
        const result = await fn(p);
        note({ action, params: p, result });
        return result;
    }

    async function detect() {
        const out = { installed: false, dllPath: null, running: false, type: null, version: null, strips: [], buses: [], macroButtons: false, profiles: listProfiles() };
        const wasIn = loggedIn;
        try {
            try { await load(); } catch (e) {
                if (e.code === 'voicemeeter_not_installed') return out;
                throw e;
            }
            out.installed = true;
            out.dllPath = injected ? null : dllPath;
            login();
            let l;
            try { l = layout(); } catch (e) { if (e.code === 'voicemeeter_not_running') return out; throw e; }
            out.running = true;
            out.type = l.type;
            const v = vm.getVersion();
            out.version = v.rc === 0 ? versionString(v.value) : null;
            refresh();
            const label = (param) => {
                try { const r = vm.getString(`${param}.Label`); return r.rc === 0 ? String(r.value).slice(0, 100) : ''; } catch { return ''; }
            };
            for (let i = 0; i < l.strips; i++) {
                const isVirtual = i >= l.hwStrips;
                const lab = label(`Strip[${i}]`);
                const n = isVirtual ? i - l.hwStrips + 1 : i + 1;
                out.strips.push({ index: i, label: lab, name: lab || (isVirtual ? `Virtual input ${n}` : `Hardware input ${n}`), isVirtual });
            }
            l.buses.forEach((b, i) => { const lab = label(`Bus[${i}]`); out.buses.push({ index: i, label: lab, name: lab || b }); });
            try { out.macroButtons = !!vm.hasMacro && vm.macroIsDirty() >= 0; } catch { out.macroButtons = false; }
            return out;
        } finally {
            // Detect while turned off: leave nothing loaded or logged in.
            if (!on && !wasIn) unload();
        }
    }

    function configure({ enabled: en } = {}) {
        const next = !!en;
        if (next === on) return;
        on = next;
        if (!on) { unload(); log('info', 'turned off'); return; }
        log('info', 'turned on');
        load().then(() => { if (on) login(); }).catch((e) => log('info', 'not ready', { code: e.code }));
    }

    return {
        configure,
        detect,
        run,
        handlers: () => Object.fromEntries(VOICEMEETER_ACTIONS.map((a) => [a, (p) => run(a, p)])),
        status: () => ({ enabled: on, loaded: !!vm, loggedIn, dllPath: injected ? null : dllPath }),
        close: unload,
    };
}

/**
 * An in-memory Voicemeeter with the binding interface above, for tests and the device sandbox.
 *   fakeVoicemeeterBinding(record?, { type: 'basic'|'banana'|'potato', running, version: 'a.b.c.d',
 *                                     labels: { 'Strip[0]': 'Mic' }, macro: bool })
 * `record` (a function or an array) receives { kind: 'voicemeeter-fake', call, ... } for every write.
 * The fake's state is on `.state` (params, loads, scripts, macro, macroCalls, calls); `.state.running` can be flipped.
 */
function fakeVoicemeeterBinding(record = null, opts = {}) {
    const typeNum = { basic: 1, banana: 2, potato: 3 }[opts.type || 'banana'] || 2;
    const l = TYPES[typeNum];
    const state = {
        running: opts.running !== false,
        loggedIn: false,
        params: {},              // 'Strip[0].Mute' → number, 'Strip[0].Label' → string
        loads: [],               // Command.Load paths
        scripts: [],
        macro: new Array(MACRO_BUTTONS).fill(0),
        macroCalls: [],
        calls: [],
    };
    for (let i = 0; i < l.strips; i++) Object.assign(state.params, { [`Strip[${i}].Mute`]: 0, [`Strip[${i}].Gain`]: 0, [`Strip[${i}].Label`]: '' });
    for (let i = 0; i < l.buses.length; i++) Object.assign(state.params, { [`Bus[${i}].Mute`]: 0, [`Bus[${i}].Gain`]: 0, [`Bus[${i}].Label`]: '' });
    for (const [k, v] of Object.entries(opts.labels || {})) state.params[`${k}.Label`] = String(v);
    const [a, b, c, d] = String(opts.version || `${typeNum}.1.1.9`).split('.').map((x) => Number(x) & 0xff);
    const packed = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    const rec = (entry) => {
        state.calls.push(entry);
        try {
            if (typeof record === 'function') record({ kind: 'voicemeeter-fake', ...entry });
            else if (Array.isArray(record)) record.push({ kind: 'voicemeeter-fake', ...entry });
        } catch { /* ignore */ }
    };
    const up = () => state.running;
    const known = (name) => Object.prototype.hasOwnProperty.call(state.params, name);
    const macroOn = opts.macro !== false;
    const LOAD_RE = /^Command\.Load = "(.+)";$/;
    const FADE_RE = /^((?:Strip|Bus)\[\d+\])\.FadeTo = \((-?\d+(?:\.\d+)?), (\d+)\);$/;

    return {
        state,
        login() { if (state.loggedIn) return -2; state.loggedIn = true; return up() ? 0 : 1; },
        logout() { state.loggedIn = false; return 0; },
        getType: () => (up() ? { rc: 0, value: typeNum } : { rc: -2, value: 0 }),
        getVersion: () => (up() ? { rc: 0, value: packed } : { rc: -2, value: 0 }),
        isParametersDirty: () => (up() ? 0 : -2),
        getFloat(name) {
            if (!up()) return { rc: -2, value: 0 };
            if (!known(name) || typeof state.params[name] !== 'number') return { rc: -3, value: 0 };
            return { rc: 0, value: state.params[name] };
        },
        getString(name) {
            if (!up()) return { rc: -2, value: '' };
            if (!known(name) || typeof state.params[name] !== 'string') return { rc: -3, value: '' };
            return { rc: 0, value: state.params[name] };
        },
        setFloat(name, value) {
            if (!up()) return -2;
            if (!known(name) || typeof state.params[name] !== 'number') return -3;
            state.params[name] = Math.fround(value);
            rec({ call: 'setFloat', name, value });
            return 0;
        },
        setParameters(script) {
            if (!up()) return -2;
            state.scripts.push(script);
            const load = script.match(LOAD_RE);
            if (load) { state.loads.push(load[1]); rec({ call: 'load', file: path.basename(load[1]) }); return 0; }
            const fade = script.match(FADE_RE);
            if (fade) {
                if (!known(`${fade[1]}.Gain`)) return 1;
                state.params[`${fade[1]}.Gain`] = Number(fade[2]);
                rec({ call: 'fade', name: `${fade[1]}.Gain`, value: Number(fade[2]), ms: Number(fade[3]) });
                return 0;
            }
            return 1;
        },
        hasMacro: macroOn,
        macroIsDirty: () => (macroOn ? (up() ? 0 : -2) : -1),
        macroGetStatus(button) {
            if (!up()) return { rc: -2, value: 0 };
            if (button < 0 || button >= MACRO_BUTTONS) return { rc: -3, value: 0 };
            return { rc: 0, value: state.macro[button] };
        },
        macroSetStatus(button, value, mode) {
            if (!up()) return -2;
            if (button < 0 || button >= MACRO_BUTTONS) return -3;
            state.macro[button] = value ? 1 : 0;
            state.macroCalls.push({ button, value, mode });
            rec({ call: 'macro', button, value, mode });
            return 0;
        },
        unload() {},
    };
}

module.exports = {
    createVoicemeeter, fakeVoicemeeterBinding, locateVoicemeeterDll, loadVoicemeeterDll, uninstallDir, versionString,
    VOICEMEETER_ACTIONS,
};
