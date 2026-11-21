'use strict';
/*
 * "Run a program on your PC" (Studio 0.2.11, server step system.run, capability 'run').
 *
 * The server only names a program. What runs is decided here, on this PC: the streamer's own list (Settings, Programs it may
 * run), each entry a name, the full path of a program file the streamer picked, and optional fixed arguments typed in Studio.
 * Nothing from the server is ever used as a path, an argument or a command line. A name that is not on the list is refused
 * (not_allowed), and so is a file that is gone (not_found). No shell is used for .exe files; .bat and .cmd files go through
 * cmd.exe /d /c with the arguments from the list only.
 *
 *   validateProgram({ name, path, args }, { exists })  → { ok, value: { id, name, path, args }, error }
 *   createProgramRunner({ getList, spawnImpl, exists, logger, now })
 *     .run({ program }) → { program, pid }   throws Error with .code not_allowed | not_found | bad_params | rate | failed
 * At most 10 runs a minute, so a looping automation cannot start a program over and over.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: defaultSpawn } = require('node:child_process');

const NAME = /^[\w .()-]{1,100}$/;
const EXT = new Set(['.exe', '.bat', '.cmd']);
const MAX_PROGRAMS = 50;
const MAX_ARGS = 20;
const RUNS_PER_MINUTE = 10;

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

function validateProgram(p, { exists = (f) => fs.existsSync(f) } = {}) {
    const name = String(p?.name ?? '').replace(/\s+/g, ' ').trim();
    if (!NAME.test(name)) return { ok: false, error: 'Give it a name of 1 to 100 letters, numbers, spaces, . _ - or brackets. Automations use this name.' };
    const file = String(p?.path ?? '').trim();
    if (!path.isAbsolute(file) || file.length > 500) return { ok: false, error: 'Pick the program file.' };
    if (!EXT.has(path.extname(file).toLowerCase())) return { ok: false, error: 'Pick a program (.exe) or a batch file (.bat or .cmd).' };
    if (!exists(file)) return { ok: false, error: 'That file is not there.' };
    const raw = Array.isArray(p?.args) ? p.args : String(p?.args ?? '').trim() ? String(p.args).match(/"[^"]*"|\S+/g) || [] : [];
    const args = raw.map((a) => String(a).replace(/^"(.*)"$/, '$1')).filter((a) => a.length);
    if (args.length > MAX_ARGS || args.some((a) => a.length > 200 || /[\r\n\0]/.test(a))) return { ok: false, error: `At most ${MAX_ARGS} arguments of up to 200 characters each.` };
    return { ok: true, value: { id: /^[a-f0-9]{12}$/.test(String(p?.id || '')) ? p.id : crypto.randomBytes(6).toString('hex'), name, path: file, args } };
}

function createProgramRunner({ getList = () => [], spawnImpl = defaultSpawn, exists = (f) => fs.existsSync(f), logger = null, now = () => Date.now() } = {}) {
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[programs] ${m}`, meta); } catch { /* ignore */ } };
    let recent = [];
    return {
        async run(params = {}) {
            const want = String(params.program ?? '').replace(/\s+/g, ' ').trim();
            if (!NAME.test(want)) throw fail('bad_params', 'program must be the name of a program on Studio\'s list');
            const list = (getList() || []).slice(0, MAX_PROGRAMS);
            const entry = list.find((x) => String(x.name).toLowerCase() === want.toLowerCase());
            if (!entry) {
                log('warn', 'refused a program that is not on the list', { program: want });
                throw fail('not_allowed', `"${want}" is not in Studio's list of programs it may run (Settings, Programs it may run)`);
            }
            const t = now();
            recent = recent.filter((x) => t - x < 60_000);
            if (recent.length >= RUNS_PER_MINUTE) throw fail('rate', 'Too many programs started in the last minute');
            if (!exists(entry.path)) throw fail('not_found', `The file for "${entry.name}" is not there any more`);
            recent.push(t);
            const ext = path.extname(entry.path).toLowerCase();
            const [cmd, args] = ext === '.exe'
                ? [entry.path, entry.args || []]
                : [process.env.ComSpec || 'cmd.exe', ['/d', '/c', entry.path, ...(entry.args || [])]];
            const child = await new Promise((resolve, reject) => {
                let c;
                try { c = spawnImpl(cmd, args, { cwd: path.dirname(entry.path), detached: true, stdio: 'ignore', windowsHide: ext !== '.exe', shell: false }); } catch (e) { reject(fail('failed', e.message)); return; }
                c.once('error', (e) => reject(fail('failed', e.message)));
                c.once('spawn', () => resolve(c));
            });
            try { child.unref(); } catch { /* fine */ }
            log('info', 'program started', { program: entry.name, pid: child.pid });
            return { program: entry.name, pid: child.pid ?? null };
        },
    };
}

module.exports = { validateProgram, createProgramRunner, MAX_PROGRAMS, RUNS_PER_MINUTE };
