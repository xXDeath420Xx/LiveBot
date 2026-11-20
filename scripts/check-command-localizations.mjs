#!/usr/bin/env node
/**
 * Dry run of the slash command payload with its translations: what the automatic deploy
 * (core/bot-manager.js runCommandDeploy -> buildDeployJson -> localizeCommands) would send, measured
 * against Discord's 8,000-character limit per command, plus translation coverage per locale. Sends
 * nothing to Discord and writes nothing.
 *
 *   node scripts/check-command-localizations.mjs [--missing] [--json FILE]
 *
 *   --missing   list every description path that has no translation, per locale
 *   --json      also write the full report to FILE
 *
 * Covers every deployable command: the default bot's global set and the guild-scoped ones that custom bots
 * and opted-in servers get. Exit 0 = every command fits, 1 = a command is over the limit, 2 = could not run.
 * Translations: locales/commands/<locale>.json (utils/i18n-catalogue.js); sizes: utils/command-localization.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const args = process.argv.slice(2);
const out = (s) => fs.writeSync(1, `${s}\n`);   // process.exit below would lose piped console.log output

async function main() {
    const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
    const { buildDeployJson, commandChars } = await imp('core/command-mounts.js');
    const { localizeCommand, discordCommandSize, DISCORD_COMMAND_LIMIT, LOCALIZED_BUDGET } = await imp('utils/command-localization.js');
    const { availableLocales, DEFAULT_LOCALE } = await imp('utils/i18n-catalogue.js');

    const modules = [];
    for (const dir of fs.readdirSync(path.join(ROOT, 'commands'))) {
        const d = path.join(ROOT, 'commands', dir);
        if (!fs.statSync(d).isDirectory()) continue;
        for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) {
            const m = await import(pathToFileURL(path.join(d, f)).href);
            if (m.default?.data?.toJSON) modules.push(m.default);
        }
    }
    const payload = buildDeployJson(modules);   // every deployable command (global + guild-scoped)
    const globalNames = new Set(buildDeployJson(modules.filter((m) => !m.guildScoped)).map((j) => j.name));
    const locales = availableLocales().filter((l) => l !== DEFAULT_LOCALE);
    const discordLocales = locales.flatMap((l) => (l === 'es-ES' ? ['es-ES', 'es-419'] : [l]));

    const report = { limit: DISCORD_COMMAND_LIMIT, budget: LOCALIZED_BUDGET, locales: discordLocales, commands: [], coverage: {}, missing: {} };
    for (const l of discordLocales) { report.coverage[l] = { fields: 0, localized: 0 }; report.missing[l] = []; }

    for (const json of payload) {
        const english = commandChars(json);
        const stats = { names: 0, descriptions: 0 };
        localizeCommand(json, stats);
        const size = discordCommandSize(json);
        // Coverage after fitting: every node with a description.
        (function walk(node, key) {
            if (node.description) {
                for (const l of discordLocales) {
                    report.coverage[l].fields++;
                    if (node.description_localizations?.[l]) report.coverage[l].localized++;
                    else report.missing[l].push(key);
                }
            }
            for (const o of node.options || []) walk(o, `${key}.${o.name}`);
        })(json, json.name);
        report.commands.push({ name: json.name, type: json.type ?? 1, global: globalNames.has(json.name), english, localized: size, dropped: stats.dropped || 0, descriptions: stats.descriptions });
    }
    report.commands.sort((a, b) => b.localized - a.localized);

    out(`Commands: ${payload.length} (${report.commands.filter((c) => c.global).length} global, ${report.commands.filter((c) => !c.global).length} guild-scoped)`);
    out(`Limit ${DISCORD_COMMAND_LIMIT} per command; localizations are trimmed above ${LOCALIZED_BUDGET}.`);
    out('\nLargest commands (Discord count: longest version of each field):');
    out('  command                     english  localized  dropped');
    for (const c of report.commands.slice(0, 12)) {
        out(`  /${c.name.padEnd(25)} ${String(c.english).padStart(7)}  ${String(c.localized).padStart(9)}  ${String(c.dropped).padStart(7)}`);
    }
    out('\nDescription coverage:');
    for (const [l, c] of Object.entries(report.coverage)) out(`  ${l.padEnd(7)} ${c.localized}/${c.fields} (${((100 * c.localized) / (c.fields || 1)).toFixed(1)}%)`);
    const dropped = report.commands.reduce((n, c) => n + c.dropped, 0);
    if (dropped) out(`\n${dropped} description localization(s) dropped to fit: ${report.commands.filter((c) => c.dropped).map((c) => `/${c.name} ${c.dropped}`).join(', ')}`);
    if (args.includes('--missing')) {
        for (const [l, list] of Object.entries(report.missing)) if (list.length) out(`\nMissing ${l} (${list.length}):\n  ${list.join('\n  ')}`);
    }
    const i = args.indexOf('--json');
    if (i >= 0 && args[i + 1]) fs.writeFileSync(args[i + 1], JSON.stringify(report, null, 1));

    const over = report.commands.filter((c) => c.localized > DISCORD_COMMAND_LIMIT);
    if (over.length) {
        out(`\nOVER THE LIMIT: ${over.map((c) => `/${c.name} ${c.localized}`).join(', ')}`);
        return 1;
    }
    out('\nEvery command fits.');
    return 0;
}

main().then((code) => process.exit(code), (error) => {
    fs.writeSync(2, `check-command-localizations could not run: ${error.stack || error.message}\n`);
    process.exit(2);
});
