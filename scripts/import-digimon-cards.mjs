/*
 * Fills the Digimon Card Game columns of digimon_data (card_dp, card_level, card_color, card_keywords,
 * card_inherited, card_dps, card_match) from digimoncard.io, so battles use real card DP and keywords.
 *
 *   cd ~/CertiFriedUtility && set -a && source .env && set +a && node scripts/import-digimon-cards.mjs
 *
 * One request: /api-public/search?type=Digimon returns every Digimon card with its DP and effect text
 * (the API allows 15 requests per 10 seconds, so this is nowhere near it). Safe to re-run.
 *
 * Names: our data uses the Japanese names (digi-api), the cards the English ones. A Digimon is matched by
 * exact name, then by ALIASES (hand-checked; fuzzy matching paired Tailmon with Trailmon), then by its name
 * without a bracketed variant ("Agumon (Black)" → Agumon's cards). Anything left keeps NULL and battles use the
 * card game's usual DP for its level (LEVEL_DP in core/digimon-logic.js).
 */
import pool from '../utils/db.js';
import { normaliseName, summariseCards } from '../core/digimon-logic.js';

const URL = 'https://digimoncard.io/api-public/search?type=Digimon&series=Digimon%20Card%20Game';
const UA = 'CertiFriedMultitool/1.0 (Discord bot; https://certifriedmultitool.com)';

// Japanese (digi-api) → English card name, both normalised. Only pairs checked by hand.
const ALIASES = {
    tailmon: 'gatomon', blacktailmon: 'blackgatomon', piyomon: 'biyomon', plotmon: 'salamon', vmon: 'veemon',
    xvmon: 'exveemon', vdramon: 'veedramon', aerovdramon: 'aeroveedramon', goldvdramon: 'goldveedramon',
    ulforcevdramon: 'ulforceveedramon', tyranomon: 'tyrannomon', darktyranomon: 'darktyrannomon',
    extyranomon: 'extyrannomon', metaltyranomon: 'metaltyrannomon', mastertyranomon: 'mastertyrannomon',
    vegimon: 'vegiemon', redvegimon: 'redvegiemon', marinangemon: 'marineangemon', marindevimon: 'marinedevimon',
    mechanorimon: 'mekanorimon', octmon: 'octomon', tortamon: 'tortomon', shakomon: 'shakkoumon',
    gottsumon: 'gotsumon', heraklekabuterimon: 'herculeskabuterimon', holydramon: 'magnadramon',
    jyagamon: 'jagamon', brachimon: 'brachiomon', candmon: 'candlemon', darklizamon: 'darklizardmon',
    flarelizamon: 'flarerizamon', millenniumon: 'millenniummon', moonmillenniumon: 'moonmillenniummon',
    zeedmillenniumon: 'zeedmillenniummon', omegamon: 'omnimon', goburimon: 'goblimon', snowgoburimon: 'snowgoblimon',
    tukaimon: 'tsukaimon', vamdemon: 'myotismon', venomvamdemon: 'venommyotismon', belialvamdemon: 'malomyotismon',
    wizarmon: 'wizardmon', flawizarmon: 'flamewizardmon', piemon: 'piedmon', shamamon: 'shamanmon',
    goddramon: 'goldramon', hyougamon: 'hyogamon', fladramon: 'flamedramon', galgomon: 'gargomon',
    blackgalgomon: 'blackgargomon', pegasmon: 'pegasusmon', anubimon: 'anubismon', beelzebumon: 'beelzemon',
    beelzebumonblastmode: 'beelzemonblastmode', cerberumon: 'cerberusmon', mephismon: 'mephistomon',
    growmon: 'growlmon', blackgrowmon: 'blackgrowlmon', agnimon: 'agunimon', mercuremon: 'mercurymon',
    thunderbirmon: 'thunderbirdmon', regulumon: 'regulusmon', sorcerimon: 'sorcermon', wendimon: 'wendigomon',
    calamaramon: 'calmaramon', dinohumon: 'dinohyumon', holyangemon: 'magnaangemon', mugendramon: 'machinedramon',
    armadimon: 'armadillomon', pumpmon: 'pumpkinmon', pinochimon: 'puppetmon', piccolomon: 'piximon',
    hououmon: 'phoenixmon', tonosamagekomon: 'shogungekomon', deathmeramon: 'skullmeramon', mammon: 'mammothmon',
    skullmammon: 'skullmammothmon', archnemon: 'arukenimon', orgemon: 'ogremon', bakumon: 'tapirmon',
    minotaurmon: 'minotarumon', yukiagumon: 'snowagumon', picodevimon: 'demidevimon', xuanwumon: 'ebonwumon',
    qinglongmon: 'azulongmon', chimairamon: 'chimeramon', rukamon: 'dolphmon',
};

const res = await fetch(URL, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
if (!res.ok) { console.log(`digimoncard.io answered HTTP ${res.status}`); process.exit(1); }
const cards = await res.json();
console.log(`${cards.length} Digimon cards`);

const byName = new Map();
for (const c of cards) {
    const k = normaliseName(c.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
}

const [ours] = await pool.query('SELECT id, name FROM digimon_data');
const found = { exact: 0, alias: 0, base: 0, none: 0 };
for (const d of ours) {
    const k = normaliseName(d.name);
    const base = normaliseName(d.name.replace(/\(.*?\)/g, ''));
    let how = null, list = null;
    if (byName.has(k)) { how = 'exact'; list = byName.get(k); }
    else if (ALIASES[k] && byName.has(ALIASES[k])) { how = 'alias'; list = byName.get(ALIASES[k]); }
    else if (base !== k && (byName.has(base) || byName.has(ALIASES[base]))) { how = 'base'; list = byName.get(base) ?? byName.get(ALIASES[base]); }
    found[how ?? 'none']++;
    if (!list) {
        await pool.execute(`UPDATE digimon_data SET card_dp = NULL, card_level = NULL, card_color = NULL, card_keywords = NULL,
                            card_inherited = NULL, card_dps = NULL, card_match = NULL WHERE id = ?`, [d.id]);
        continue;
    }
    // Printings differ; summariseCards takes the common DP, level and colour and the keywords most printings share.
    const c = summariseCards(list);
    await pool.execute(
        `UPDATE digimon_data SET card_dp = ?, card_level = ?, card_color = ?, card_keywords = ?, card_inherited = ?, card_dps = ?, card_match = ?
          WHERE id = ?`,
        [c.dp, c.level, c.color, JSON.stringify(c.keywords), JSON.stringify(c.inherited), JSON.stringify(c.dps), how, d.id]);
}
console.log(`matched: ${found.exact} by name, ${found.alias} by alias, ${found.base} by base form; ${found.none} without a card`);
process.exit(0);
