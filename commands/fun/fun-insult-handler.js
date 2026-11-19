/*
 * /fun insult [user] [language] — a roast, opt-in per server.
 *
 * Settings live on the existing Fun & Party Games feature (core/feature-config-spec.js `fun`):
 * `insults_enabled` (default off), `insult_source` and `insult_language`:
 *   builtin     core/insult-generator.js — hand-written, playful parts combined at random (English)
 *   evilinsult  core/evil-insults.js — evilinsult.com's public-domain database, served from our own
 *               copy (data/evil-insults.json; their API blocks servers). Crude, including sexual jokes.
 *               `language` (or the server's insult_language) picks the language; no repeats within
 *               the server's last 50 lines; "[Name]" in a line becomes the target's mention.
 * (Wave 17 removed an earlier Evil Insult source that called the API and never worked; migration 335
 * reset saved settings to built-in. Wave 20 brought it back, served locally.)
 *
 * Every line, from either source, must pass core/hate-terms.js rejectReason: the bot-wide slur floor,
 * then this server's own automod banned words and message patterns (getGuildWordFilter). A line that
 * fails is re-rolled; Evil Insult falls back to the built-in generator after several hits. Filtered
 * lines are logged at most once per 10 minutes per server as 'system.insultFiltered'.
 */
import { getConfig } from '../../core/feature-config.js';
import { logFeatureEvent } from '../../core/feature-log.js';
import { getGuildWordFilter } from '../../core/advanced-automod-manager.js';
import { rejectReason } from '../../core/hate-terms.js';
import { pickInsult } from '../../core/insult-generator.js';
import { evilInsults, LANGUAGES } from '../../core/evil-insults.js';

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';
const languageName = (code) => LANGUAGES.find(l => l.code === code)?.name || code;

/** The server's word filter in the shape core/hate-terms.js serverFilterHit wants (kept for callers). */
export const serverFilter = getGuildWordFilter;

export async function handleInsult(interaction) {
    const cfg = await getConfig('fun', interaction.guildId);
    if (!truthy(cfg.insults_enabled)) {
        return interaction.reply({
            content: 'Insults are turned off in this server. A server admin can turn on **Allow /fun insult** in the dashboard under Fun & Party Games.',
            ephemeral: true,
        });
    }

    let target = interaction.options.getUser('user') || interaction.user;
    let lead = '';
    if (target.id === interaction.client.user.id) {
        lead = 'Nice try. ';
        target = interaction.user;
    }
    const source = cfg.insult_source === 'evilinsult' ? 'evilinsult' : 'builtin';
    const askedLang = interaction.options.getString('language');

    await interaction.deferReply();
    const filter = await getGuildWordFilter(interaction.guildId);
    const reject = (text) => rejectReason(text, filter);
    const mention = `<@${target.id}>`;
    const pick = source === 'evilinsult'
        ? await evilInsults.random(askedLang || cfg.insult_language || 'en', { name: mention, guildId: interaction.guildId, reject })
        : await pickInsult({ reject });
    const { line, source: used, filtered } = pick;

    if (filtered.length) {
        const guild = interaction.guild;
        void logFeatureEvent(() => guild, 'system.insultFiltered', () => ({
            title: 'Insult filtered',
            description: `/fun insult skipped ${filtered.length} line${filtered.length === 1 ? '' : 's'} before answering.`,
            fields: [
                ['Source', source === 'evilinsult' ? 'Evil Insult (local copy)' : 'Built-in'],
                ['Posted', used === 'none' ? 'Nothing passed the filters' : used === 'evilinsult' ? 'An Evil Insult line that passed' : 'A built-in line that passed'],
                ['Caught by', [...new Set(filtered.map(f => f.reason))].join(', ')],
            ],
            footer: 'Shown at most once every 10 minutes',
            throttle: { key: `insult:${guild?.id}`, ms: 10 * 60 * 1000 },
        }));
    }

    await interaction.editReply({
        content: pick.named ? `${lead}${line}` : `${lead}${mention} ${line}`,
        allowedMentions: { users: [target.id], parse: [] },
    });

    // The language option only means something for Evil Insult; say so rather than ignore it silently.
    let note = null;
    if (askedLang && source !== 'evilinsult') {
        note = 'This server uses the built-in insults, which are English only. An admin can switch **Insult source** to Evil Insult in the dashboard under Fun & Party Games.';
    } else if (askedLang && used === 'evilinsult' && pick.lang !== String(askedLang).toLowerCase()) {
        note = `There are no ${languageName(askedLang)} insults, so that one was English.`;
    }
    if (note) await interaction.followUp({ content: note, ephemeral: true }).catch(() => {});
}

export default { handleInsult, serverFilter };
