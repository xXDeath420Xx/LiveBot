/*
 * Which commands are registered with Discord as slash commands and which are served only as text
 * commands (owner-approved split, 2026-11-18; the full table is docs/command-split-2026-11-18.md).
 *
 * Every command stays reachable from chat through the universal bridge (core/universal-commands.js):
 * `!owo hunt`, `?owo hunt` and, for the commands below, `/owo hunt` typed as an ordinary message.
 * Only what this file marks as slash is sent to Discord by buildDeployJson (core/command-mounts.js),
 * which every deploy path uses (core/bot-manager.js for the main bot and custom bots,
 * events/guildCreate.js, core/guild-shortcuts.js, the deploy scripts).
 *
 * Stays a slash command: admin, setup, moderation and protection commands; anything whose reply has to
 * be private (personal settings, privacy, account linking, secrets typed as input); anything that opens a
 * popup form (a chat message cannot); one main entry per big feature (/help, /music, /level, /digimon);
 * all context menus.
 * Text only: game, fun and social trees, lookups, and deep subcommands of big features.
 *
 * A module can override its entry here with `registration: 'slash' | 'text'` and
 * `slashPaths` / `textPaths` arrays on its default export.
 *
 * Rules a text command must keep (tests/command-split.test.js checks all of them):
 *  - its "/" form never starts with the name of a registered slash command, because Discord's client
 *    takes over anything that starts with a registered name;
 *  - it is never one of Discord's built-in commands (BUILTIN_NAMES);
 *  - every subcommand of every module is reachable as slash or as text.
 */

// Top-level commands served only as text. Moved commands (core/command-mounts.js) are listed under
// their own name: `cc` is listed because it is the command; `/tools cc` only ever existed as a mount.
export const TEXT_COMMANDS = new Set([
    // Critters (the /owo game), merged back into one text tree (TEXT_MERGE)
    'owo', 'owo2', 'owo-profile', 'autohunt',
    // Fun and social
    'fun', 'owoify', 'luck', 'imagine', 'cah', 'economy', 'cannabis',
    // Games
    'arcade', 'tree', 'windrose', 'cat', 'fish', 'pokemon', 'rpg', 'tournament', 'wordgame',
    // Lookups and knowledge
    'knowledge', 'media', 'deals', 'server', 'stats', 'user', 'discover', 'lookup', 'movie', 'watch',
    // Personal tools and actions
    'tools', 'ping', 'cc', 'notes', 'selfcare', 'voice', 'soundboard', 'soundboard-play',
]);

// Paths that stay slash inside a text command (the exception goes the other way).
// Paths are relative to the command: 'sub', 'group' (all of it) or 'group sub'.
export const SLASH_PATHS = Object.freeze({
    fun: ['confess'],                                   // anonymous: typing it in chat would show who sent it; opens a form
    selfcare: ['wellness mood', 'wellness moodstats'],  // mood tracking is private
});

// Paths served only as text inside a slash command: deep lookups of big features.
export const TEXT_PATHS = Object.freeze({
    music: ['lastfm nowplaying', 'lastfm recent', 'lastfm topartists', 'lastfm toptracks',
        'lastfm topalbums', 'lastfm compare', 'lastfm profile'],
});

// Text trees folded into another one: `/owo shards` runs /owo2 shards, `/owo profile view` runs
// /owo-profile view. The command that runs (and its restriction rows) is still the source command.
export const TEXT_MERGE = Object.freeze({
    owo2: { into: 'owo' },
    'owo-profile': { into: 'owo', as: 'profile' },
    autohunt: { into: 'owo', as: 'autohunt' },
});

// Flattened natural names for text commands: first word -> the words it stands for.
// Only needed where the bridge's own shortcuts (a bare subcommand or group name, when unambiguous)
// do not already give a free name. Never a registered slash name or a built-in.
export const TEXT_ALIASES = Object.freeze({
    // /fun stays registered for /fun confess, so the rest of /fun needs names of its own
    joke: 'fun joke',
    dadjoke: 'fun dadjoke',
    meme: 'fun meme',
    creatememe: 'fun creatememe',
    funfact: 'fun fact',
    wouldyourather: 'fun wouldyourather',
    wyr: 'fun wouldyourather',
    '8ball': 'fun 8ball',
    insult: 'fun insult',
    party: 'fun partygames',
    // /selfcare stays registered for the mood tracker
    habit: 'selfcare habit',
    challenges: 'selfcare challenges',
    wellness: 'selfcare wellness',
    tasks: 'selfcare tasks',
    // natural names for moved or nested commands
    charts: 'stats',
    hunt: 'owo hunt',
    zoo: 'owo zoo',
});

// Run as text, these paths send their private (ephemeral) replies by DM instead of in the channel.
export const PRIVATE_TEXT_PATHS = new Set([
    'tools generate password',
    'arcade greenhouse link',   // a link code joins another sign-in to the save
]);

// Every path under these commands, too. Self-care (/habit, /tasks, /challenges, /wellness typed as text) answers
// privately when the server keeps its replies private (Self-Care page, H-718); only replies the command marks
// private go by DM, so with that setting off its progress posts stay in the channel.
export const PRIVATE_TEXT_COMMANDS = new Set(['selfcare']);

/** Does this text path send its private replies by DM? */
export function isPrivateTextPath(path) {
    const p = String(path || '').trim();
    return PRIVATE_TEXT_PATHS.has(p) || PRIVATE_TEXT_COMMANDS.has(p.split(' ')[0]);
}

// Discord's own slash commands. The client handles these itself; a text command must never use one.
export const BUILTIN_NAMES = new Set(['shrug', 'tableflip', 'unflip', 'me', 'spoiler', 'nick', 'tts', 'giphy', 'thread']);

const SUB = 1, GROUP = 2;

function moduleOverride(cmd) {
    const r = cmd?.registration;
    return r === 'slash' || r === 'text' ? r : null;
}

/** The command's default registration: 'text' or 'slash'. */
export function registrationOf(name, cmd = null) {
    return moduleOverride(cmd) ?? (TEXT_COMMANDS.has(name) ? 'text' : 'slash');
}

function exceptionsFor(name, cmd, def) {
    if (def === 'text') return (Array.isArray(cmd?.slashPaths) ? cmd.slashPaths : null) ?? SLASH_PATHS[name] ?? [];
    return (Array.isArray(cmd?.textPaths) ? cmd.textPaths : null) ?? TEXT_PATHS[name] ?? [];
}

/**
 * Is this path of the command registered as slash? `rel` is relative to the command: '' for the
 * command itself, 'sub', 'group' or 'group sub'.
 */
export function isSlashPath(name, rel = '', cmd = null) {
    const def = registrationOf(name, cmd);
    const r = String(rel || '').trim().toLowerCase();
    const hit = r !== '' && exceptionsFor(name, cmd, def).some(e => r === e || r.startsWith(e + ' '));
    return def === 'slash' ? !hit : hit;
}

/** 'slash', 'text' or 'mixed' (some paths each way) for a command module. */
export function commandType(name, cmd = null, json = null) {
    let j = json;
    if (!j) { try { j = cmd?.data?.toJSON?.() ?? null; } catch { j = null; } }
    if ((j?.type ?? 1) !== 1) return 'slash';   // context menus are always registered
    const rels = relPaths(j);
    const slash = rels.filter(r => isSlashPath(name, r, cmd)).length;
    return slash === rels.length ? 'slash' : slash === 0 ? 'text' : 'mixed';
}

/** Every leaf path of a command's JSON, relative to the command ('' when it has no subcommands). */
export function relPaths(json) {
    const opts = json?.options ?? [];
    if (!opts.some(o => o.type === SUB || o.type === GROUP)) return [''];
    const out = [];
    for (const o of opts) {
        if (o.type === SUB) out.push(o.name);
        else if (o.type === GROUP) for (const s of o.options ?? []) out.push(`${o.name} ${s.name}`);
    }
    return out;
}

/**
 * The command's JSON with only its slash paths, or null when nothing of it is registered.
 * Context menus (type 2/3) are always kept. Returns the same object when nothing was removed.
 */
export function slashJson(name, json, cmd = null) {
    if (!json) return null;
    if ((json.type ?? 1) !== 1) return json;
    const opts = json.options ?? [];
    const hasSubs = opts.some(o => o.type === SUB || o.type === GROUP);
    if (!hasSubs) return isSlashPath(name, '', cmd) ? json : null;

    let removed = false;
    const kept = [];
    for (const o of opts) {
        if (o.type === SUB) {
            if (isSlashPath(name, o.name, cmd)) kept.push(o); else removed = true;
        } else if (o.type === GROUP) {
            const subs = (o.options ?? []).filter(s => isSlashPath(name, `${o.name} ${s.name}`, cmd));
            if (subs.length === (o.options ?? []).length) kept.push(o);
            else { removed = true; if (subs.length) kept.push({ ...o, options: subs }); }
        } else {
            kept.push(o);
        }
    }
    if (!kept.some(o => o.type === SUB || o.type === GROUP)) return null;
    return removed ? { ...json, options: kept } : json;
}

/**
 * A command module as deploy code sees it: unchanged, filtered to its slash paths, or null when it is
 * text only. Only `data.name` and `data.toJSON()` are read by the deploy builders.
 */
export function forSlashDeploy(cmd) {
    let json;
    try { json = cmd?.data?.toJSON?.(); } catch { return null; }
    if (!json) return null;
    const name = cmd.data.name;
    const filtered = slashJson(name, json, cmd);
    if (!filtered) return null;
    if (filtered === json) return cmd;
    return { ...cmd, data: { name, toJSON: () => structuredClone(filtered) } };
}
