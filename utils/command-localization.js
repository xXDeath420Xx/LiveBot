import { localizationMap, availableLocales, DEFAULT_LOCALE } from './i18n-catalogue.js';
import logger from './logger.js';

/**
 * Attach Discord's native command localizations to a built command payload.
 *
 * This is the cheapest localization win available to a Discord bot and the
 * network was using none of it: 0 uses of setNameLocalizations across 76 root
 * commands, 1,124 subcommands and 1,308 options. Discord renders command names
 * and descriptions in each user's own client language at zero runtime cost —
 * the strings ship once with the command definition and Discord does the rest.
 *
 * Rather than editing 76 command files to add per-field localization maps, this
 * walks the built JSON and fills in anything the catalogue has a translation
 * for, keyed by structural path:
 *
 *     commands.<command>.name / .description
 *     commands.<command>.<subcommand>.name / .description
 *     commands.<command>.<subcommand>.<option>.name / .description
 *
 * A command with no catalogue entries is left exactly as-is, so this is safe to
 * run over every command whether or not anyone has translated it yet, and
 * translations can be added later without touching code.
 *
 * ## Discord's constraints, which this enforces
 *
 * - Command and option *names* must be lowercase and match
 *   `^[-_\\p{L}\\p{N}\\p{sc=Deva}\\p{sc=Thai}]{1,32}$`. A translation with a
 *   space or a capital is rejected by the API for the whole payload, taking
 *   every command with it — so a bad name is dropped here, with a warning,
 *   rather than allowed to break the deploy.
 * - Descriptions are 1–100 characters.
 * - One command (with its subcommands, options and choices) may total 8,000
 *   characters of names, descriptions and choice values. With localizations,
 *   Discord counts the longest version of each field. One command over the
 *   limit fails the whole bulk PUT, so every command is measured after its
 *   localizations are applied and, if it would pass LOCALIZED_BUDGET, the
 *   description localizations that add the most are dropped (logged) until it
 *   fits. `node scripts/check-command-localizations.mjs` is the dry run.
 */

/** Discord's limit for one command, and the budget used here (a margin for rounding in Discord's count). */
export const DISCORD_COMMAND_LIMIT = 8000;
export const LOCALIZED_BUDGET = 7900;

const longest = (base, map) => Math.max(String(base ?? '').length, ...Object.values(map || {}).map((v) => String(v).length));

/**
 * A command's size as Discord counts it: for every name and description the longest of the default and its
 * localizations, plus choice names (longest) and choice values, over the command, its groups, subcommands and
 * options.
 */
export function discordCommandSize(json) {
    let n = longest(json.name, json.name_localizations) + longest(json.description, json.description_localizations);
    for (const o of json.options || []) {
        n += discordCommandSize(o);
        for (const c of o.choices || []) n += longest(c.name, c.name_localizations) + String(c.value ?? '').length;
    }
    return n;
}

/** Every node of a command that carries description localizations, with how much each one adds to the size. */
function localizedNodes(json, out = []) {
    if (json.description_localizations) {
        out.push({ node: json, extra: longest('', json.description_localizations) - String(json.description ?? '').length });
    }
    for (const o of json.options || []) localizedNodes(o, out);
    return out;
}

/**
 * Bring a localized command under the budget by removing description localizations, the ones that add the
 * most first, and within one field only its longest locales. Returns how many localizations were dropped.
 */
export function fitLocalizedSize(json, budget = LOCALIZED_BUDGET) {
    let size = discordCommandSize(json);
    if (size <= budget) return 0;
    let dropped = 0;
    while (size > budget) {
        const nodes = localizedNodes(json).filter((x) => x.extra > 0).sort((a, b) => b.extra - a.extra);
        if (!nodes.length) break;
        const { node } = nodes[0];
        const base = String(node.description ?? '').length;
        const map = node.description_localizations;
        const max = Math.max(...Object.values(map).map((v) => String(v).length));
        for (const [locale, value] of Object.entries(map)) {
            if (String(value).length === max && max > base) { delete map[locale]; dropped++; }
        }
        if (!Object.keys(map).length) delete node.description_localizations;
        size = discordCommandSize(json);
    }
    return dropped;
}

/** Discord locale codes we can serve, derived from the catalogues we hold. */
function discordLocalesFor() {
    // Catalogue basenames double as Discord locale codes except where the
    // catalogue serves several (en -> en-US/en-GB, es-ES -> es-ES/es-419).
    const extra = { en: ['en-US', 'en-GB'], 'es-ES': ['es-ES', 'es-419'] };
    return availableLocales()
        .filter((l) => l !== DEFAULT_LOCALE)
        .flatMap((l) => extra[l] || [l]);
}

const NAME_PATTERN = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

function validName(value) {
    return typeof value === 'string' && value === value.toLowerCase() && NAME_PATTERN.test(value);
}

function validDescription(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 100;
}

/** Filter a localization map, dropping entries Discord would reject. */
function sanitize(map, kind, path) {
    if (!map) return undefined;
    const out = {};
    for (const [locale, value] of Object.entries(map)) {
        const ok = kind === 'name' ? validName(value) : validDescription(value);
        if (ok) out[locale] = value;
        else {
            logger.warn(
                `[i18n] Dropped invalid ${kind} localization for "${path}" (${locale}): ${JSON.stringify(value)}` +
                (kind === 'name' ? ' — command names must be lowercase, no spaces, max 32 chars.' : ' — descriptions are 1-100 chars.')
            );
        }
    }
    return Object.keys(out).length ? out : undefined;
}

function applyTo(node, keyPath, discordLocales, stats) {
    const nameMap = sanitize(localizationMap(`${keyPath}.name`, { discordLocales }), 'name', keyPath);
    if (nameMap) {
        node.name_localizations = { ...(node.name_localizations || {}), ...nameMap };
        stats.names += Object.keys(nameMap).length;
    }

    const descMap = sanitize(localizationMap(`${keyPath}.description`, { discordLocales }), 'description', keyPath);
    if (descMap) {
        node.description_localizations = { ...(node.description_localizations || {}), ...descMap };
        stats.descriptions += Object.keys(descMap).length;
    }
}

/**
 * Walk a built command payload and fill in every localization the catalogue has.
 *
 * @param {object} json  Output of SlashCommandBuilder#toJSON().
 * @param {object} [stats] Accumulator, so a caller can total across all commands.
 * @returns {object} The same object, mutated.
 */
export function localizeCommand(json, stats = { names: 0, descriptions: 0 }) {
    const discordLocales = discordLocalesFor();
    if (!discordLocales.length) return json;
    localizeTree(json, discordLocales, stats);
    const dropped = fitLocalizedSize(json);
    if (dropped) {
        stats.descriptions -= dropped;
        stats.dropped = (stats.dropped || 0) + dropped;
        logger.warn(`[i18n] /${json.name}: dropped ${dropped} description localization(s) to stay under Discord's ${DISCORD_COMMAND_LIMIT}-character command limit (now ${discordCommandSize(json)})`);
    }
    return json;
}

/** Fill in the catalogue's localizations on a command and every group, subcommand and option under it. */
function localizeTree(json, discordLocales, stats) {
    const root = `commands.${json.name}`;
    applyTo(json, root, discordLocales, stats);

    // Subcommands are type 1, subcommand groups type 2; both nest options.
    for (const child of json.options || []) {
        const childPath = `${root}.${child.name}`;
        applyTo(child, childPath, discordLocales, stats);

        for (const grandchild of child.options || []) {
            const gcPath = `${childPath}.${grandchild.name}`;
            applyTo(grandchild, gcPath, discordLocales, stats);

            // A subcommand inside a group has its own options one level deeper.
            for (const option of grandchild.options || []) {
                applyTo(option, `${gcPath}.${option.name}`, discordLocales, stats);
            }
        }
    }

    return json;
}

/**
 * Localize a whole set of command payloads and log the totals.
 * Called from the deploy paths so every bot gets the same treatment.
 */
export function localizeCommands(payloads) {
    const stats = { names: 0, descriptions: 0 };
    for (const payload of payloads) localizeCommand(payload, stats);

    if (stats.names || stats.descriptions) {
        logger.info(
            `[i18n] Applied ${stats.names} name and ${stats.descriptions} description localizations ` +
            `across ${payloads.length} commands (${discordLocalesFor().join(', ')})` +
            (stats.dropped ? `; ${stats.dropped} dropped to fit Discord's command size limit` : '')
        );
    }
    return payloads;
}

export default { localizeCommand, localizeCommands, discordCommandSize, fitLocalizedSize, DISCORD_COMMAND_LIMIT, LOCALIZED_BUDGET };
