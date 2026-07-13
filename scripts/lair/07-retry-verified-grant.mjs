// Retry the bulk Verified grant with proper 429 handling + slow pacing.
import 'dotenv/config';
import fs from 'fs';

const GUILD = '1216126780767731722';
const state = JSON.parse(fs.readFileSync('/home/death/CertiFriedUtility/scripts/lair/state.json', 'utf8'));
const VERIFIED = state.roles['Verified'];
const token = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + token };

// Fetch current live member list (not stale recon)
let members = [], after = '0';
while (true) {
    const r = await fetch(`https://discord.com/api/v10/guilds/${GUILD}/members?limit=1000&after=${after}`, { headers: H });
    if (!r.ok) break;
    const batch = await r.json();
    if (!batch.length) break;
    members.push(...batch);
    after = batch[batch.length - 1].user.id;
    if (batch.length < 1000) break;
}
console.log(`fetched ${members.length} live members`);

const needsVerified = members.filter(m => !m.user.bot && !m.roles.includes(VERIFIED));
console.log(`needs Verified: ${needsVerified.length}`);

let granted = 0, failed = 0;
for (const m of needsVerified) {
    let attempts = 0;
    while (attempts < 5) {
        const r = await fetch(`https://discord.com/api/v10/guilds/${GUILD}/members/${m.user.id}/roles/${VERIFIED}`, { method: 'PUT', headers: H });
        if (r.ok) { granted++; break; }
        if (r.status === 429) {
            const body = await r.json().catch(() => ({ retry_after: 1 }));
            const waitMs = Math.ceil((body.retry_after || 1) * 1000) + 100;
            await new Promise(res => setTimeout(res, waitMs));
            attempts++;
            continue;
        }
        if (r.status === 404) { break; /* member left */ }
        console.log(`  ${m.user.username}: ${r.status} ${await r.text()}`);
        failed++;
        break;
    }
    // Pace: ~10 per second max (Discord's limit). 100ms between = 10/s conservative.
    await new Promise(res => setTimeout(res, 100));
    if ((granted + failed) % 50 === 0) console.log(`  progress: granted=${granted}, failed=${failed}`);
}
console.log(`\nDONE: granted=${granted}, failed=${failed}`);
