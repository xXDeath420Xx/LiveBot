// Windrose+ advanced INI overrides — 2,461 tunables across six files.
//
// HOW THE UPSTREAM SYSTEM WORKS, and the one rule that must not be broken:
//
//   config/windrose_plus.<name>.default.ini  — every key at its GAME DEFAULT,
//                                              shipped read-only as reference
//   server-files/windrose_plus.<name>.ini    — YOUR overrides
//
// The default files say it plainly: "Only changed values are patched — defaults
// are left alone." The override file is a sparse diff, not a copy.
//
// That distinction is load-bearing. If the panel wrote all 2,461 keys back, it
// would freeze today's defaults as explicit overrides forever — and the next
// game balance patch would silently not apply, because every value it tuned is
// now pinned by us. So writes here are strictly diff-only: a key equal to its
// default is REMOVED from the override file rather than written.
//
// Values take effect on next boot; they are compiled into a PAK at launch.

import { readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export class IniError extends Error {}

// name → { default file, override file }. `default` has no infix.
const FILES = {
    general: { def: 'windrose_plus.default.ini', override: 'windrose_plus.ini', label: 'General' },
    weapons: { def: 'windrose_plus.weapons.default.ini', override: 'windrose_plus.weapons.ini', label: 'Weapons' },
    food: { def: 'windrose_plus.food.default.ini', override: 'windrose_plus.food.ini', label: 'Food & alchemy' },
    entities: { def: 'windrose_plus.entities.default.ini', override: 'windrose_plus.entities.ini', label: 'Entities' },
    gear: { def: 'windrose_plus.gear.default.ini', override: 'windrose_plus.gear.ini', label: 'Gear & armour' },
    harvest: { def: 'windrose_plus.harvest.default.ini', override: 'windrose_plus.harvest.ini', label: 'Harvest yields' },
};

/**
 * Parse an INI, keeping the comment that precedes each key as its description.
 * Upstream documents every tunable that way and it is the only thing making
 * 2,461 opaque identifiers navigable.
 */
export function parseIni(text) {
    const sections = [];
    let current = null;
    let pendingComment = [];

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();

        if (!line) { pendingComment = []; continue; }

        if (line.startsWith(';') || line.startsWith('#')) {
            const body = line.replace(/^[;#]\s?/, '').trim();
            // Banner rules (";====") are decoration, not documentation.
            if (body && !/^=+$/.test(body)) pendingComment.push(body);
            continue;
        }

        const sec = line.match(/^\[(.+)\]$/);
        if (sec) {
            current = { name: sec[1], description: pendingComment.join(' ') || null, keys: [] };
            sections.push(current);
            pendingComment = [];
            continue;
        }

        const kv = line.match(/^([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/);
        if (kv) {
            if (!current) { current = { name: '(root)', description: null, keys: [] }; sections.push(current); }
            const value = kv[2].trim();
            current.keys.push({
                key: kv[1],
                value,
                // "Raw: <identifier>" comments are just the internal name echoed
                // back; keep them, they are how you find a weapon by asset name.
                description: pendingComment.join(' ') || null,
                type: inferType(value),
            });
            pendingComment = [];
        }
    }
    return sections;
}

function inferType(value) {
    if (value === '') return 'empty';
    if (value === 'true' || value === 'false') return 'bool';
    if (/^-?\d+$/.test(value)) return 'int';
    if (/^-?\d*\.\d+$/.test(value)) return 'float';
    return 'string';
}

/** Flatten parsed sections into a `Section.key` → value map. */
function flatten(sections) {
    const map = new Map();
    for (const s of sections) for (const k of s.keys) map.set(`${s.name}.${k.key}`, k.value);
    return map;
}

export function createIniFiles({ serverFiles = config.serverFiles, docker } = {}) {
    const configDir = path.join(serverFiles, 'config');

    function spec(name) {
        const f = FILES[name];
        if (!f) throw new IniError(`unknown config file "${name}"`);
        return f;
    }

    async function readDefaults(name) {
        const f = spec(name);
        try {
            return parseIni(await readFile(path.join(configDir, f.def), 'utf8'));
        } catch (err) {
            if (err.code === 'ENOENT') throw new IniError(`${f.def} is missing — is Windrose+ installed?`);
            throw err;
        }
    }

    async function readOverrides(name) {
        const f = spec(name);
        try {
            return flatten(parseIni(await readFile(path.join(serverFiles, f.override), 'utf8')));
        } catch (err) {
            if (err.code === 'ENOENT') return new Map(); // no overrides yet is normal
            throw err;
        }
    }

    return {
        FILES,

        /** Which files exist, how many keys each has, how many are overridden. */
        async summary() {
            const out = [];
            for (const [name, f] of Object.entries(FILES)) {
                let keyCount = 0;
                let sectionCount = 0;
                try {
                    const secs = await readDefaults(name);
                    sectionCount = secs.length;
                    keyCount = secs.reduce((n, s) => n + s.keys.length, 0);
                } catch { /* file missing — reported as zero */ }
                const overrides = await readOverrides(name).catch(() => new Map());
                out.push({ name, label: f.label, file: f.override, sectionCount, keyCount, overrideCount: overrides.size });
            }
            return { files: out };
        },

        /**
         * Full schema for one file: every key with its default, current
         * override (if any), description and inferred type.
         */
        async describe(name) {
            const [defaults, overrides] = await Promise.all([readDefaults(name), readOverrides(name)]);
            const sections = defaults.map((s) => ({
                name: s.name,
                description: s.description,
                keys: s.keys.map((k) => {
                    const id = `${s.name}.${k.key}`;
                    const override = overrides.has(id) ? overrides.get(id) : null;
                    return {
                        id,
                        key: k.key,
                        default: k.value,
                        value: override ?? k.value,
                        overridden: override !== null,
                        description: k.description,
                        type: k.type,
                    };
                }),
            }));
            return { name, label: spec(name).label, file: spec(name).override, sections };
        },

        /**
         * Apply a patch of `Section.key` → value.
         *
         * Diff-only, in both directions: a value equal to the default DROPS the
         * override rather than writing it. That is what keeps the override file
         * sparse and lets future game patches move the untouched defaults.
         */
        async setOverrides(name, patch) {
            if (!patch || typeof patch !== 'object') throw new IniError('patch must be an object');

            // Advisory rather than enforced: these are read at PAK build on the
            // next launch, so editing while running is harmless — it simply has
            // no effect until restart. Worth saying, not worth blocking.
            const running = docker ? (await docker.state()).running : false;

            const f = spec(name);
            const defaults = flatten(await readDefaults(name));
            const overrides = await readOverrides(name);

            const changed = [];
            const cleared = [];
            for (const [id, raw] of Object.entries(patch)) {
                if (!defaults.has(id)) throw new IniError(`unknown setting "${id}"`);
                const value = String(raw ?? '').trim();
                if (/[\r\n\[\]]/.test(value)) throw new IniError(`"${id}" contains characters that would corrupt the INI`);

                if (value === defaults.get(id)) {
                    if (overrides.delete(id)) cleared.push(id);
                } else {
                    overrides.set(id, value);
                    changed.push(id);
                }
            }

            await writeOverrideFile(path.join(serverFiles, f.override), f, overrides);

            return {
                file: f.override,
                changed,
                cleared,
                overrideCount: overrides.size,
                appliesOnRestart: true,
                note: running
                    ? 'Saved. These are compiled into a PAK at launch, so restart the server to apply.'
                    : 'Saved. They will apply on next start.',
            };
        },

        /** Drop every override in a file, returning it to stock. */
        async resetFile(name) {
            const f = spec(name);
            const target = path.join(serverFiles, f.override);
            await unlink(target).catch(() => {});
            return { file: f.override, reset: true, note: 'All overrides removed; defaults apply on next start.' };
        },

        /** Search across every file — the only sane way into 2,461 keys. */
        async search(term, { limit = 200 } = {}) {
            const needle = String(term || '').toLowerCase().trim();
            if (needle.length < 2) throw new IniError('search needs at least 2 characters');

            const hits = [];
            for (const name of Object.keys(FILES)) {
                let described;
                try { described = await this.describe(name); } catch { continue; }
                for (const s of described.sections) {
                    for (const k of s.keys) {
                        if (hits.length >= limit) break;
                        const hay = `${s.name} ${k.key} ${k.description || ''}`.toLowerCase();
                        if (hay.includes(needle)) {
                            hits.push({ file: name, fileLabel: described.label, section: s.name, ...k });
                        }
                    }
                }
            }
            return { term: needle, count: hits.length, truncated: hits.length >= limit, hits };
        },
    };
}

/** Write a sparse override file, grouped by section, with a header explaining itself. */
async function writeOverrideFile(target, f, overrides) {
    if (overrides.size === 0) {
        // No overrides left: remove the file entirely rather than leaving an
        // empty one, so the state on disk matches "stock".
        await unlink(target).catch(() => {});
        return;
    }

    const bySection = new Map();
    for (const [id, value] of overrides) {
        const idx = id.lastIndexOf('.');
        const section = id.slice(0, idx);
        const key = id.slice(idx + 1);
        if (!bySection.has(section)) bySection.set(section, []);
        bySection.get(section).push([key, value]);
    }

    const lines = [
        '; ============================================================',
        `; ${f.label} — overrides only`,
        '; ============================================================',
        ';',
        '; Managed by the CertiFried Windrose panel (/wrmanager → Advanced).',
        '; Only values that DIFFER from the game default appear here; anything',
        '; absent stays on the default and keeps tracking future game patches.',
        `; Reference: config/${f.def}`,
        '; ============================================================',
        '',
    ];

    for (const [section, pairs] of [...bySection].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`[${section}]`);
        for (const [key, value] of pairs.sort((a, b) => a[0].localeCompare(b[0]))) {
            lines.push(`${key} = ${value}`);
        }
        lines.push('');
    }

    const tmp = `${target}.tmp`;
    await writeFile(tmp, lines.join('\n'), 'utf8');
    await rename(tmp, target);
}
