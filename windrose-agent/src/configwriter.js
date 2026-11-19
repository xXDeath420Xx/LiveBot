// Validated writes to windrose_plus.json and WorldDescription.json.
//
// Everything here exists because these files have sharp edges that a plain
// "PATCH the JSON" endpoint would hand straight to whoever is clicking around
// in the panel. Three in particular:
//
//  1. HALF THE MULTIPLIERS ARE FAKE. stack_size, crop_speed, weight,
//     inventory_size and points_per_level parse fine and do nothing — they are
//     disabled upstream because inventory/crop/progression changes can corrupt
//     or crash character saves. Presenting them as working knobs would be
//     actively misleading, so writes to them are rejected.
//
//  2. XP IS RATCHETED. Once an xp multiplier above 1 has been baked into a PAK,
//     lowering it is refused upstream: the shrunken reward curve can lock
//     existing characters out at next login. Raising xp is therefore a
//     ONE-WAY DOOR and the panel must say so before the click, not after.
//
//  3. MULTIPLIERS NEED A PAK REBUILD. They are compiled into
//     WindrosePlus_Multipliers_P.pak at launch, so an edit does nothing until
//     the next restart. Writing the file and reporting success would be a lie.
//
// The rcon block is the exception — it is read live and applies on wp.reload.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Multipliers the upstream PAK builder actually applies.
export const LIVE_MULTIPLIERS = {
    loot: { min: 0.1, max: 10 },
    xp: { min: 0.1, max: 10, ratchet: true },
    craft_efficiency: { min: 0.1, max: 10 },
    cooking_speed: { min: 0.1, max: 10 },
    harvest_yield: { min: 0.1, max: 10 },
};

// Accepted by the parser, ignored by the game. Rejected here with the reason.
export const DISABLED_MULTIPLIERS = {
    stack_size: 'inventory changes can crash Windrose\'s inventory validator',
    weight: 'inventory changes can crash Windrose\'s inventory validator',
    inventory_size: 'inventory changes can crash Windrose\'s inventory validator',
    crop_speed: 'non-default crop timing can crash Windrose\'s crop validator',
    points_per_level: 'changing progression rewards can cause RewardLevel < CurrentLevel save crashes',
};

/*
 * WorldDescription.json's real shape, read off a live save on 2026-08-09. The
 * container README documents the parameter NAMES but not the file layout, and
 * the layout is genuinely strange:
 *
 *   {
 *     "Version": 1,
 *     "WorldDescription": {
 *       "islandId": "5A93CB…", "WorldName": "", "CreationTime": 6.39e17,
 *       "WorldPresetType": "Medium",
 *       "WorldSettings": {
 *         "BoolParameters":  { "{\"TagName\": \"WDS.Parameter.EasyExplore\"}": false },
 *         "FloatParameters": { "{\"TagName\": \"WDS.Parameter.MobHealthMultiplier\"}": 1 },
 *         "TagParameters":   { "{\"TagName\": \"WDS.Parameter.CombatDifficulty\"}":
 *                              { "TagName": "WDS.Parameter.CombatDifficulty.Normal" } }
 *       }
 *     }
 *   }
 *
 * Three traps in there:
 *   1. Everything is nested under a "WorldDescription" key, not at the root.
 *   2. Parameter keys are not tag names — they are JSON OBJECTS SERIALISED INTO
 *      STRINGS, with a space after the colon. `{"TagName": "X"}` matches;
 *      `{"TagName":"X"}` is a different key and is silently ignored.
 *   3. Parameters are split by type into three maps, and a tag VALUE is an
 *      object whose TagName appends the choice: CombatDifficulty →
 *      "WDS.Parameter.CombatDifficulty.Hard".
 *
 * The preset field is "WorldPresetType" (Easy/Medium/Hard/Custom), not
 * "PresetType". An earlier version of this file wrote a flat structure at the
 * root and would have been ignored wholesale by the game.
 */
export const TAG_KEY = (name) => `{"TagName": "${name}"}`;

// WorldDescription.json parameters, with the ranges from the container README.
export const WORLD_FLOATS = {
    'WDS.Parameter.MobHealthMultiplier': { min: 0.2, max: 5.0 },
    'WDS.Parameter.MobDamageMultiplier': { min: 0.2, max: 5.0 },
    'WDS.Parameter.ShipsHealthMultiplier': { min: 0.4, max: 5.0 },
    'WDS.Parameter.ShipsDamageMultiplier': { min: 0.2, max: 2.5 },
    'WDS.Parameter.BoardingDifficultyMultiplier': { min: 0.2, max: 5.0 },
    'WDS.Parameter.Coop.StatsCorrectionModifier': { min: 0.0, max: 2.0 },
    'WDS.Parameter.Coop.ShipStatsCorrectionModifier': { min: 0.0, max: 2.0 },
};
export const WORLD_BOOLS = ['WDS.Parameter.Coop.SharedQuests', 'WDS.Parameter.EasyExplore'];
export const WORLD_TAGS = { 'WDS.Parameter.CombatDifficulty': ['Easy', 'Normal', 'Hard'] };

export class ConfigError extends Error {}

/** Write via temp file + rename so a crash mid-write cannot truncate a live config. */
async function writeAtomic(file, data) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 4), 'utf8');
    await rename(tmp, file);
}

/**
 * Validate a multiplier patch. Pure — no I/O — so the panel can call it to
 * preview warnings before the user commits.
 */
export function validateMultipliers(patch, current = {}) {
    const warnings = [];
    const clean = {};

    for (const [key, value] of Object.entries(patch)) {
        // Legacy alias kept by upstream with identical semantics.
        const k = key === 'craft_cost' ? 'craft_efficiency' : key;

        if (k in DISABLED_MULTIPLIERS) {
            throw new ConfigError(`"${k}" is a no-op upstream and is rejected: ${DISABLED_MULTIPLIERS[k]}`);
        }
        const spec = LIVE_MULTIPLIERS[k];
        if (!spec) throw new ConfigError(`unknown multiplier "${k}"`);

        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new ConfigError(`"${k}" must be a finite number`);
        }
        if (value < spec.min || value > spec.max) {
            // Reject rather than clamp: silently applying a different number
            // than the one the user typed is worse than an error.
            throw new ConfigError(`"${k}" must be between ${spec.min} and ${spec.max} (got ${value})`);
        }

        if (spec.ratchet) {
            const prev = current[k] ?? 1;
            if (prev > 1 && value < prev) {
                throw new ConfigError(
                    `"${k}" is ratcheted upstream: it is currently ${prev} and lowering it is refused because ` +
                    `the shrunken reward curve can lock existing characters out at next login. ` +
                    `Back up SaveProfiles first, then clear windrose_plus_data/.windroseplus_multiplier_history.json.`,
                );
            }
            if (value > 1 && value > (current[k] ?? 1)) {
                warnings.push(
                    `Raising "${k}" to ${value} is effectively ONE-WAY — once baked into a PAK it cannot be lowered again without manual recovery.`,
                );
            }
        }

        clean[k] = value;
    }

    return { values: clean, warnings };
}

export function createConfigWriter({ serverFiles = config.serverFiles, docker } = {}) {
    const wplusPath = path.join(serverFiles, 'windrose_plus.json');
    const serverDescPath = path.join(serverFiles, 'R5', 'ServerDescription.json');

    async function readJson(file, fallback = {}) {
        try {
            return JSON.parse(await readFile(file, 'utf8'));
        } catch (err) {
            if (err.code === 'ENOENT') return fallback;
            throw new ConfigError(`could not parse ${path.basename(file)}: ${err.message}`);
        }
    }

    async function assertStopped(what) {
        if (!docker) throw new ConfigError('configwriter needs a docker handle to check server state');
        const state = await docker.state();
        if (state.running) {
            throw new ConfigError(
                `refusing to edit ${what} while the server is running — the shutting-down server rewrites these files, ` +
                'so the change would be silently reverted. Stop the server first.',
            );
        }
    }

    async function worldDescriptionPath() {
        const desc = await readJson(serverDescPath);
        const id = desc?.ServerDescription_Persistent?.WorldIslandId;
        if (!id) throw new ConfigError('WorldIslandId missing from ServerDescription.json');
        // Version-scoped directory; discovered at runtime rather than hardcoded
        // because it changes with every game version.
        const worldsRoot = path.join(serverFiles, 'R5', 'Saved', 'SaveProfiles', 'Default', 'RocksDB_v2');
        const { readdir } = await import('node:fs/promises');
        const versions = (await readdir(worldsRoot).catch(() => [])).sort().reverse();
        if (!versions.length) throw new ConfigError('no save version directory found');
        return path.join(worldsRoot, versions[0], 'Worlds', id, 'WorldDescription.json');
    }

    return {
        async readAll() {
            const wplus = await readJson(wplusPath);
            return {
                multipliers: wplus.multipliers ?? {},
                rcon: { enabled: wplus.rcon?.enabled ?? false }, // password never returned
                liveMultiplierKeys: Object.keys(LIVE_MULTIPLIERS),
                disabledMultiplierKeys: Object.keys(DISABLED_MULTIPLIERS),
            };
        },

        /**
         * Patch multipliers in windrose_plus.json.
         * Requires a stopped server: values are baked into a PAK at launch, so
         * a hot edit would report success and change nothing until restart.
         */
        async setMultipliers(patch) {
            await assertStopped('multipliers');
            const current = await readJson(wplusPath);
            const { values, warnings } = validateMultipliers(patch, current.multipliers ?? {});

            const next = { ...current, multipliers: { ...(current.multipliers ?? {}), ...values } };
            await writeAtomic(wplusPath, next);

            return {
                multipliers: next.multipliers,
                warnings,
                note: 'Applied on next start — multipliers are compiled into WindrosePlus_Multipliers_P.pak at launch.',
            };
        },

        /**
         * Patch WorldDescription.json. Any WorldSettings value forces the
         * preset to "Custom"; upstream does this implicitly and we mirror it
         * explicitly so the file we write matches what the game will read.
         */
        async setWorldSettings(patch) {
            await assertStopped('world settings');
            const file = await worldDescriptionPath();

            // Read the existing description and preserve everything we do not
            // understand — islandId, CreationTime and WorldName are the game's
            // to own, and dropping them would orphan the world.
            const current = await readJson(file, null);
            if (!current || !current.WorldDescription) {
                throw new ConfigError(
                    'WorldDescription.json is missing or has no WorldDescription block. It is written by the game; ' +
                    'start the server once so the world exists before editing its settings.',
                );
            }

            const desc = { ...current.WorldDescription };
            const ws = desc.WorldSettings ?? {};
            const bools = { ...(ws.BoolParameters ?? {}) };
            const floats = { ...(ws.FloatParameters ?? {}) };
            const tags = { ...(ws.TagParameters ?? {}) };

            for (const [key, value] of Object.entries(patch)) {
                if (key in WORLD_FLOATS) {
                    const { min, max } = WORLD_FLOATS[key];
                    if (typeof value !== 'number' || !Number.isFinite(value)) {
                        throw new ConfigError(`"${key}" must be a finite number`);
                    }
                    if (value < min || value > max) {
                        throw new ConfigError(`"${key}" must be between ${min} and ${max} (got ${value})`);
                    }
                    floats[TAG_KEY(key)] = value;
                } else if (WORLD_BOOLS.includes(key)) {
                    if (typeof value !== 'boolean') throw new ConfigError(`"${key}" must be true or false`);
                    bools[TAG_KEY(key)] = value;
                } else if (key in WORLD_TAGS) {
                    if (!WORLD_TAGS[key].includes(value)) {
                        throw new ConfigError(`"${key}" must be one of ${WORLD_TAGS[key].join(', ')}`);
                    }
                    // Tag values carry the full path with the choice appended.
                    tags[TAG_KEY(key)] = { TagName: `${key}.${value}` };
                } else {
                    throw new ConfigError(`unknown world setting "${key}"`);
                }
            }

            desc.WorldSettings = { BoolParameters: bools, FloatParameters: floats, TagParameters: tags };
            // Any explicit setting makes the world Custom; the game does this
            // implicitly, and we mirror it so the file matches what it will read.
            if (Object.keys(patch).length > 0) desc.WorldPresetType = 'Custom';

            const next = { ...current, WorldDescription: desc };
            await writeAtomic(file, next);
            return { path: file, worldSettings: desc.WorldSettings, presetType: desc.WorldPresetType };
        },

        /**
         * RCON block only. Read live by Windrose+ and applied on wp.reload, so
         * unlike everything else here it does NOT require a stopped server.
         */
        async setRcon({ enabled }) {
            const current = await readJson(wplusPath);
            const next = { ...current, rcon: { ...(current.rcon ?? {}), enabled: Boolean(enabled) } };
            await writeAtomic(wplusPath, next);
            return { rcon: { enabled: next.rcon.enabled }, note: 'Applies on wp.reload — no restart needed.' };
        },

        _paths: { wplusPath, serverDescPath },
        _worldDescriptionPath: worldDescriptionPath,
    };
}
