/*
 * Registers the guildScoped commands (cannabis features) to the guilds that opted in.
 *
 * These commands are held back from the main bot's global payload by deploy-commands.js,
 * because cannabis content is not eligible for the App Directory. This puts them back for
 * the servers that actually use them.
 *
 * Guild registration is a bulk overwrite, so anything already registered in a guild that is
 * NOT one of ours is read first and passed through -- otherwise a deploy here would silently
 * delete unrelated guild commands (CertiFried has /jellyfin and /spotify, for example).
 *
 * Usage: node scripts/deploy-guild-scoped-commands.js [--dry-run]
 */
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import mysql from 'mysql2/promise';
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { forSlashDeploy } from '../core/command-registration.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

// Every guildScoped command name, registered or not: a text-only one (core/command-registration.js)
// must still be removed from the guilds it was registered in before the split.
const allScopedNames = new Set();
async function loadScopedCommands() {
    const out = [];
    const commandsPath = join(root, 'commands');
    for (const folder of fs.readdirSync(commandsPath)) {
        const folderPath = join(commandsPath, folder);
        if (!fs.statSync(folderPath).isDirectory()) continue;
        for (const file of fs.readdirSync(folderPath).filter(f => f.endsWith('.js'))) {
            try {
                const mod = await import(`file://${join(folderPath, file)}`);
                if (mod.default?.guildScoped && mod.default?.data) {
                    allScopedNames.add(mod.default.data.name);
                    const slash = forSlashDeploy(mod.default);
                    if (slash) out.push(slash.data.toJSON());
                }
            } catch (err) {
                console.error(`  load failed ${folder}/${file}: ${err.message}`);
            }
        }
    }
    return out;
}

const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306
});

try {
    const scoped = await loadScopedCommands();
    const scopedNames = new Set([...scoped.map(c => c.name), ...allScopedNames]);
    console.log(`guild-scoped commands: ${scoped.map(c => '/' + c.name).join(' ')}`);

    // command_names (migration 436): the commands this server gets, as a JSON array; NULL = all of them.
    const [guilds] = await db.query('SELECT * FROM guild_scoped_commands WHERE enabled = 1');
    console.log(`opted-in guilds: ${guilds.length}${dryRun ? '  (DRY RUN)' : ''}\n`);

    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    const appId = process.env.DISCORD_CLIENT_ID;
    let ok = 0, failed = 0, skipped = 0;

    for (const { guild_id: guildId, note, command_names: commandNames } of guilds) {
        let only = null;
        try { only = commandNames ? new Set(JSON.parse(commandNames)) : null; } catch { only = null; }
        const label = `${guildId} ${(note || '').slice(0, 34).padEnd(36)}`;
        try {
            const existing = await rest.get(Routes.applicationGuildCommands(appId, guildId));
            const keep = existing.filter(c => !scopedNames.has(c.name));
            const body = [...keep, ...scoped.filter(c => !only || only.has(c.name))];
            if (dryRun) {
                console.log(`  ${label} would PUT ${body.length} (keep ${keep.length}: ${keep.map(c => c.name).join(',') || 'none'})`);
            } else {
                const res = await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
                console.log(`  ${label} ok -> ${res.length} guild commands (kept ${keep.length})`);
            }
            ok++;
        } catch (err) {
            // 50001 Missing Access: the main bot is not in this server. A custom bot serves it, and that
            // bot's own deploy (core/bot-manager.js) registers its per-server commands; not a failure.
            if (err.code === 50001 || err.rawError?.code === 50001) {
                console.log(`  ${label} skipped: the main bot is not in this server (a custom bot serves it)`);
                skipped++;
            } else {
                console.error(`  ${label} FAILED ${err.status || ''} ${err.message}`);
                failed++;
            }
        }
    }
    console.log(`\n${ok} ok, ${skipped} skipped, ${failed} failed`);
    if (failed) process.exitCode = 1;
} catch (err) {
    console.error('deploy failed:', err.message);
    process.exitCode = 1;
} finally {
    await db.end();
}
process.exit(process.exitCode || 0);
