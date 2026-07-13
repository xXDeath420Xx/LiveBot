// Phase 1 — Read-only recon of Mama Bear's Lair (1216126780767731722).
// Dumps server shape, MEE6 presence, member list with mamabear_xal resolution,
// and writes everything to scripts/lair/recon.json for subsequent phases.
//
// Does NOT modify anything.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const GUILD = '1216126780767731722';
const MEE6_ID = '159985870458322944';
const OUT = path.resolve('/home/death/CertiFriedUtility/scripts/lair/recon.json');

const token = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + token };

async function rest(url) {
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText + ' ' + url + ' :: ' + await r.text());
    return r.json();
}

const out = { guild_id: GUILD, fetched_at: new Date().toISOString() };

// 1. Guild metadata
out.guild = await rest(`https://discord.com/api/v10/guilds/${GUILD}?with_counts=true`);
console.log('guild:', out.guild.name, '— owner:', out.guild.owner_id, '— members:', out.guild.approximate_member_count);

// 2. Roles
out.roles = await rest(`https://discord.com/api/v10/guilds/${GUILD}/roles`);
console.log('roles:', out.roles.length);

// 3. Channels
out.channels = await rest(`https://discord.com/api/v10/guilds/${GUILD}/channels`);
const byType = {};
for (const c of out.channels) byType[c.type] = (byType[c.type] || 0) + 1;
console.log('channels:', out.channels.length, 'breakdown:', byType);
const nsfwChans = out.channels.filter(c => c.nsfw);
if (nsfwChans.length) console.log('nsfw channels:', nsfwChans.map(c => '#' + c.name).join(', '));

// 4. All guild members (paginated)
out.members = [];
let after = '0';
while (true) {
    const batch = await rest(`https://discord.com/api/v10/guilds/${GUILD}/members?limit=1000&after=${after}`);
    if (!batch.length) break;
    out.members.push(...batch);
    after = batch[batch.length - 1].user.id;
    if (batch.length < 1000) break;
}
console.log('members:', out.members.length);

// 5. MEE6 presence check + mamabear_xal location
const mee6 = out.members.find(m => m.user.id === MEE6_ID);
out.mee6_in_guild = !!mee6;
console.log('MEE6 in guild:', out.mee6_in_guild);

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const xal = out.members.find(m =>
    norm(m.user.username) === 'mamabearxal' ||
    norm(m.user.global_name) === 'mamabearxal' ||
    norm(m.nick) === 'mamabearxal' ||
    norm(m.user.username).includes('mamabear') ||
    norm(m.user.global_name || '').includes('mamabear')
);
out.mamabear_xal = xal ? { id: xal.user.id, username: xal.user.username, global_name: xal.user.global_name, nick: xal.nick, roles: xal.roles } : null;
console.log('mamabear_xal:', out.mamabear_xal?.username, '(' + out.mamabear_xal?.id + ')' || 'NOT FOUND');

// 6. Webhooks (look for MEE6 webhooks or anything we need to preserve)
try {
    out.webhooks = await rest(`https://discord.com/api/v10/guilds/${GUILD}/webhooks`);
    console.log('webhooks:', out.webhooks.length);
    const mee6Webhooks = out.webhooks.filter(w => /mee6/i.test(w.name || '') || w.owner?.id === MEE6_ID);
    console.log('  MEE6 webhooks:', mee6Webhooks.length);
} catch (e) { console.log('webhooks fetch failed:', e.message); out.webhooks = []; }

// 7. Integrations (MEE6 appears as an integration)
try {
    out.integrations = await rest(`https://discord.com/api/v10/guilds/${GUILD}/integrations`);
    console.log('integrations:', out.integrations.map(i => i.name).join(', '));
} catch (e) { console.log('integrations fetch failed:', e.message); out.integrations = []; }

// 8. Check MEE6's public leaderboard API for cached level data
try {
    const r = await fetch(`https://mee6.xyz/api/plugins/levels/leaderboard/${GUILD}?limit=1000`);
    if (r.ok) {
        const data = await r.json();
        out.mee6_leaderboard = data.players || [];
        console.log('MEE6 leaderboard: public, ' + out.mee6_leaderboard.length + ' players cached');
    } else {
        out.mee6_leaderboard_error = r.status + ' ' + r.statusText;
        console.log('MEE6 leaderboard not public:', out.mee6_leaderboard_error);
    }
} catch (e) {
    out.mee6_leaderboard_error = e.message;
    console.log('MEE6 leaderboard fetch error:', e.message);
}

// 9. Native Discord AutoMod rules
try {
    out.automod = await rest(`https://discord.com/api/v10/guilds/${GUILD}/auto-moderation/rules`);
    console.log('automod rules:', out.automod.length);
} catch (e) { out.automod = []; }

// Write everything to disk
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('\nwrote recon to', OUT);
console.log('size:', (fs.statSync(OUT).size / 1024).toFixed(1), 'KB');
