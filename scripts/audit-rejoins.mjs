import 'dotenv/config';
import { resolveBotForGuild } from '../utils/bot-resolver.js';
import { Client, GatewayIntentBits } from 'discord.js';

const GUILD_ID = '1099732505243959407';

const KICKED = [
    ['1437511917873795104', 'cobaltclown', 1, '10:00'],
    ['1036528267647270922', 'apple17997', 1, '10:00'],
    ['1136402979906388110', 'ohheydeedee_62236', 0, '10:00'],
    ['435882739972046848', 'kaneotn', 1, '10:00'],
    ['1471275329120243853', 'vauxe_25836', 1, '10:00'],
    ['1415127191460511774', 'darkman2.00033', 1, '10:00'],
    ['1225820124632711269', 'realamaygamer', 1, '10:00'],
    ['403425238169157634', 'a_lar97', 1, '10:00'],
    ['1471928970130886758', 'travelwives', 1, '10:00'],
    ['1338013541361254495', '13attlestar', 1, '10:00'],
    ['199384315245625345', 'wingedkitsune', 1, '10:00'],
    ['1287279027324719229', 'murkydonut', 1, '10:00'],
    ['532724859248312320', 'mschiefmaker', 1, '10:00'],
    ['1326409663918637076', 'jajajagger', 1, '10:00'],
    ['86848801293221888', 'emberslodge', 1, '10:00'],
    ['413200875612274690', 'riotcontrol67', 1, '10:00'],
    ['747122651792932924', 'sephysaurusyt', 1, '10:00'],
    ['296145457816535040', 'cosmicpsycho', 1, '10:00'],
    ['466509067389632514', 'rhecredneck91', 1, '10:00'],
    ['1105601615232245822', 'knightrider_32__', 1, '10:00'],
    ['1465451887825518656', 'handywthesteel_20992', 1, '10:00'],
    ['899001168460664843', 'jpawhees', 1, '10:00'],
    ['725838985544597576', 'cheekycheeks47', 1, '10:00'],
    ['1418851369657434203', 'rambo_sosa762.', 1, '10:00'],
    ['683413460302037035', 'xxxkittybabyxxx7476', 1, '10:00'],
    ['316381401534693377', 'marilefabled', 1, '16:15'],
    ['1122375259639783538', 'shaunboii905', 1, '16:15'],
    ['425852336636821505', 'iwuvyouhekka', 1, '16:15'],
    ['357290215112572928', 'ladyccr', 1, '16:15'],
    ['785958421257650206', 'moon.light_13', 1, '16:15'],
    ['531823341124845568', 'bustersodo', 1, '16:15'],
    ['1193625679326085164', 'brittyboop87', 1, '16:15'],
    ['697722718367383572', 'tsbjoker22', 1, '16:15'],
    ['1520447370997796985', 'kai688373', 1, '16:15'],
    ['822953592805392405', 'visiongamingrp', 1, '16:15'],
    ['1525117402348785764', 'untalverdin.', 1, '16:15'],
    ['1525500128079909014', 'itsirisherexd.', 1, '16:15'],
    ['985765995295678484', 'valiantpanda251', 1, '16:15'],
    ['571909836048957480', 'cabinetterror6', 1, '16:15'],
    ['259518367533236224', 'kittenkryptid', 1, '16:15'],
    ['1394699698496864417', 'javisto5', 1, '16:15'],
    ['582453786468155402', 'xannityx', 1, '16:15'],
    ['216327576874909696', '26ninjas', 1, '16:15'],
    ['737965570049179690', 'emma_rose_', 0, '16:16'],
    ['1203904439522562048', 'waguwolf', 1, '16:16'],
    ['780287740570370061', 'ttv_essencevoid', 0, '16:16'],
    ['1455636659486855362', 'frodo0158', 1, '16:16'],
    ['759081243496284160', 'samdavison1', 1, '16:16'],
    ['1493682947373535385', 'teddgaming1987', 1, '16:16'],
    ['1126366084212195420', 'kaela91', 1, '16:16'],
];

const resolved = await resolveBotForGuild(GUILD_ID);
if (!resolved) {
    console.error('Could not resolve bot for guild', GUILD_ID);
    process.exit(1);
}

const token = resolved.token;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.login(token);
});

const guild = await client.guilds.fetch(GUILD_ID);
console.log(`Connected as bot in ${guild.name}\n`);

const results = { rejoined: [], notBack: [], errors: [] };

for (const [userId, username, dm, sweep] of KICKED) {
    try {
        const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
        if (member) {
            const joinedAt = member.joinedAt ? member.joinedAt.toISOString() : 'unknown';
            results.rejoined.push({ userId, username, sweep, joinedAt });
        } else {
            results.notBack.push({ userId, username, sweep, dm });
        }
    } catch (err) {
        results.errors.push({ userId, username, error: err.message });
    }
    await new Promise(r => setTimeout(r, 150));
}

console.log(`\n=== REJOINED (${results.rejoined.length}/50) ===`);
for (const r of results.rejoined) {
    console.log(`  ${r.sweep} sweep | ${r.username} (${r.userId}) rejoined ${r.joinedAt}`);
}

console.log(`\n=== NOT RETURNED (${results.notBack.length}/50) ===`);
console.log(`DM delivered: ${results.notBack.filter(r => r.dm).length} | DM failed: ${results.notBack.filter(r => !r.dm).length}`);
for (const r of results.notBack) {
    const dmTag = r.dm ? '' : ' [no DM]';
    console.log(`  ${r.sweep} sweep | ${r.username} (${r.userId})${dmTag}`);
}

if (results.errors.length) {
    console.log(`\n=== ERRORS ===`);
    for (const e of results.errors) console.log(`  ${e.username}: ${e.error}`);
}

await client.destroy();
process.exit(0);
