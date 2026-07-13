// Prettify every channel in Mama Bear's Lair — text channels get `emoji┃name`,
// voice channels get `emoji Name`. Skips channels that already have a leading emoji
// so we don't over-format ones the community already knows (like 🐻mama-bear-is-live).
import 'dotenv/config';

const GUILD = '1216126780767731722';
const token = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' };

async function rest(method, url, body) {
    for (let i = 0; i < 6; i++) {
        const r = await fetch(url, { method, headers: H, body: body && JSON.stringify(body) });
        if (r.status === 429) {
            const b = await r.json().catch(() => ({ retry_after: 1 }));
            await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 150));
            continue;
        }
        if (r.status === 404) return null;
        if (!r.ok) { console.log(`  ${method} ${url}: ${r.status} ${await r.text()}`); return null; }
        return r.status === 204 ? null : r.json();
    }
    return null;
}

// Targeted renames by channel id. Only touches channels that don't already have a
// leading emoji + sensible format. Keys = channel IDs, values = new display names.
const RENAMES = {
    // Lair Entrance
    '1216603920542208000': '📜┃welcome-rules',
    '1216126782131142657': '👋┃new-family',
    '1276691164598370346': '🎂┃bearthdays',
    '1219872594120020018': '📢┃announcements',
    // The Main Lair
    '1216612880829513758': '💬┃chitchat',
    '1220535269560815636': '✨┃introductions',
    '1394016953018089513': '📖┃bear-dictionary',
    '1396890470675906711': '🎨┃fan-art',
    // Mama Bear's Office
    '1219864544592265316': '🏢 Conference Room',
    '1226744434163580991': '📅┃stream-schedule',
    '1222217013888417902': '📋┃bulletin-board',
    '1220217633857732779': '💡┃suggestions',
    '1228385140346982451': '💼┃modbear-chat',
    '1367953814694662184': '📊┃server-activity',
    '1372361092793372872': '📮┃po-box',
    // Mama & The ModBears
    '1367984616035713065': '🎫┃mod-help',
    // Oh, The Things You Do!
    '1220536616280653824': '📸┃photography',
    '1218255862611841064': '🍽️┃food-pics',
    '1220536787701862411': '🐾┃pets',
    '1250109089027981404': '🖋️┃tattoos',
    '1383706656151699486': '🍯┃recipes',
    '1218255790511624314': '🖌️┃arts-and-crafts',
    '1218255932975218789': '🎨┃digital-art',
    '1218256131898740806': '📦┃collections',
    '1366149462132527176': '🔞┃jokes-nsfw',
    '1230058128242901064': '🎙️┃podcasts-memes',
    '1235687674300338178': '🎵┃music-jamz',
    // Lair Bear Care
    '1416848587966517383': '🤝 One-on-One',
    '1219863099558072361': '🧠┃mental-health',
    '1219863656938864724': '💪┃self-care',
    '1269894299420463146': '🏳️‍🌈┃lgbtqia+',
    '1475530813478142033': '💝┃fundraising',
    // Stream Specific Channels
    '1455071000273096758': '🔧 Tech Help VC',
    '1457561921585942588': '🐻┃mama-bear-is-live',
    '1457540221452423271': '🎮┃streamers-live',
    '1457541374424387768': '🚀┃self-promo',
    '1457561697857568900': '🎯┃reaching-affiliate',
    '1227494018179534890': '🛍️┃merch',
    '1232726253237178399': '🔧┃stream-tech',
    // TwitchCon
    '1461481242791907429': '📋┃twitchcon-headcount',
    '1457518596019327028': '📅┃twitchcon-2026',
    '1427340000550191267': '📸┃twitchcon-2025',
    // Game People Play
    '1369779062859497532': '🎁┃free-games',
    '1235970127623880826': '🎮┃gaming-ids',
    '1266862595051356274': '💡┃new-games',
    '1317742294035599371': '🎯┃character-clips',
    '1339706478470369424': '🐉┃dnd-chat',
    // Voice
    '1216126782131142660': '🐻 Voice Cave 1',
    '1216126782131142661': '🐾 Voice Cave 2',
    '1416529970305433771': '🧠 Mental Health VC',
    '1436996286338564096': '🎮 Mama\'s Gaming VC',
    '1408713904376250450': '🐻 ModBear Chat',
};

let touched = 0, skipped = 0;
for (const [id, newName] of Object.entries(RENAMES)) {
    // Fetch current name to skip no-ops
    const ch = await rest('GET', `https://discord.com/api/v10/channels/${id}`);
    if (!ch) { skipped++; continue; }
    if (ch.name === newName) { skipped++; continue; }
    const r = await rest('PATCH', `https://discord.com/api/v10/channels/${id}`, { name: newName });
    if (r) {
        console.log(`  ${ch.name}  →  ${newName}`);
        touched++;
    }
}
console.log(`\ndone: renamed ${touched}, skipped ${skipped}`);
