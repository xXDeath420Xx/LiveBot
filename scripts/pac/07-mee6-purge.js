// Phase R — scrub residual MEE6 messages, webhooks, and integrations from the guild.
import { ChannelType } from 'discord.js';
import { GUILD_ID, createPool, connectClient, getGuild, log } from './shared.js';

const MEE6_USER_ID = '159985870458322944'; // MEE6 bot user
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const PER_CHANNEL_SCAN_CAP = 5000; // stop per-channel after this many fetched to keep runtime bounded

async function scrubMessagesInChannel(ch) {
    if (!ch.isTextBased() || ch.type === ChannelType.GuildCategory || ch.type === ChannelType.GuildVoice) return { scanned: 0, deleted: 0 };

    let scanned = 0, deleted = 0;
    let before = null;
    const toBulk = [];
    const toSingle = [];
    while (scanned < PER_CHANNEL_SCAN_CAP) {
        let batch;
        try {
            batch = await ch.messages.fetch({ limit: 100, before });
        } catch (e) {
            log('R', `  fetch failed in ${ch.name}: ${e.message}`);
            break;
        }
        if (!batch.size) break;
        scanned += batch.size;
        const mee6 = batch.filter(m => m.author?.id === MEE6_USER_ID);
        const now = Date.now();
        for (const m of mee6.values()) {
            if (now - m.createdTimestamp < FOURTEEN_DAYS_MS) toBulk.push(m);
            else toSingle.push(m);
        }
        before = batch.last().id;
        if (batch.size < 100) break;
    }

    // Bulk delete youngest-first in chunks of 100
    while (toBulk.length) {
        const chunk = toBulk.splice(0, 100);
        try {
            const res = await ch.bulkDelete(chunk, true);
            deleted += res.size;
        } catch (e) {
            log('R', `  bulkDelete failed in ${ch.name}: ${e.message}`);
            toSingle.push(...chunk);
        }
    }
    // Single delete the rest
    for (const m of toSingle) {
        try { await m.delete(); deleted++; } catch (_) { /* likely 14d+ system-protected or already gone */ }
    }
    return { scanned, deleted };
}

async function phaseR(ctx) {
    log('R', 'Scrubbing MEE6 residue');

    // 1. Messages across every text channel
    const channels = ctx.guild.channels.cache.filter(c => c.isTextBased && c.isTextBased());
    let totalScanned = 0, totalDeleted = 0;
    for (const ch of channels.values()) {
        if (ch.type === ChannelType.GuildCategory) continue;
        const { scanned, deleted } = await scrubMessagesInChannel(ch);
        totalScanned += scanned;
        totalDeleted += deleted;
        if (deleted > 0) log('R', `  ${ch.name}: scanned=${scanned}, deleted=${deleted}`);
    }
    log('R', `message sweep complete: channels=${channels.size}, scanned=${totalScanned}, deleted=${totalDeleted}`);

    // 2. Webhooks owned by MEE6
    try {
        const webhooks = await ctx.guild.fetchWebhooks();
        let webhookHits = 0;
        for (const w of webhooks.values()) {
            const name = w.name || '';
            const ownerId = w.owner?.id;
            if (/mee6/i.test(name) || ownerId === MEE6_USER_ID) {
                await w.delete('MEE6 cleanup').catch(e => log('R', `  webhook delete failed ${w.id}: ${e.message}`));
                webhookHits++;
                log('R', `  deleted webhook ${w.name} (${w.id}) in <#${w.channelId}>`);
            }
        }
        log('R', `webhook sweep: ${webhookHits} removed`);
    } catch (e) {
        log('R', `webhook fetch failed: ${e.message}`);
    }

    // 3. Integrations — MEE6 leaves one even after kick sometimes
    try {
        const integrations = await ctx.guild.fetchIntegrations();
        let intHits = 0;
        for (const i of integrations.values()) {
            const name = i.name || '';
            const appId = i.application?.id || i.account?.id;
            if (/mee6/i.test(name) || appId === MEE6_USER_ID) {
                try {
                    await ctx.client.rest.delete(`/guilds/${GUILD_ID}/integrations/${i.id}`);
                    intHits++;
                    log('R', `  deleted integration ${i.name} (${i.id})`);
                } catch (e) {
                    log('R', `  integration delete failed: ${e.message}`);
                }
            }
        }
        log('R', `integration sweep: ${intHits} removed`);
    } catch (e) {
        log('R', `integration fetch failed: ${e.message}`);
    }

    // 4. Verify member list — MEE6 bot user should not be a member anymore
    const stillMember = await ctx.guild.members.fetch(MEE6_USER_ID).catch(() => null);
    if (stillMember) {
        log('R', `⚠  MEE6 is still a guild member. Kicking...`);
        await stillMember.kick('MEE6 cleanup').catch(e => log('R', `  kick failed: ${e.message}`));
    } else {
        log('R', 'MEE6 is not a member ✓');
    }
}

async function main() {
    const client = await connectClient();
    const pool = createPool();
    const guild = await getGuild(client);
    const ctx = { client, pool, guild };
    log('main', `logged in as ${client.user.tag}`);
    try {
        await phaseR(ctx);
    } finally {
        try { await client.destroy(); } catch (_) {}
        try { await pool.end(); } catch (_) {}
    }
}

main().catch(err => { console.error('FATAL', err?.stack || err); process.exit(1); });
