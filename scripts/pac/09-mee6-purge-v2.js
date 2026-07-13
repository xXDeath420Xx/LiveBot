// Phase R v2 — thorough MEE6 scrub. Covers text/announcement channels, forum threads,
// archived threads, and webhook-delivered MEE6 content. Logs every channel.
import { ChannelType } from 'discord.js';
import { GUILD_ID, createPool, connectClient, getGuild, log } from './shared.js';

const MEE6_USER_ID = '159985870458322944';
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Heuristics for identifying MEE6 content:
//  1. author.id === MEE6_USER_ID  (direct bot messages — the common case)
//  2. applicationId === MEE6_USER_ID  (slash-command responses)
//  3. author.username includes 'mee6' (case-insensitive) — catches webhook deliveries
//  4. embeds mention 'mee6' in footer/author — last-resort fallback
function isMee6Message(m) {
    if (m.author?.id === MEE6_USER_ID) return true;
    if (m.applicationId === MEE6_USER_ID) return true;
    if (m.author?.username && /mee6/i.test(m.author.username)) return true;
    if (m.webhookId && m.author?.username && /mee6/i.test(m.author.username)) return true;
    for (const e of m.embeds || []) {
        if (e.footer?.text && /mee6/i.test(e.footer.text)) return true;
        if (e.author?.name && /mee6/i.test(e.author.name)) return true;
    }
    return false;
}

function flush(prefix, msg) {
    const stamp = new Date().toISOString().slice(11, 19);
    process.stdout.write(`[${stamp}] ${prefix}: ${msg}\n`);
}

async function scrub(ch) {
    if (!ch.isTextBased || !ch.isTextBased()) return { skipped: 'not text-based' };
    if (ch.type === ChannelType.GuildCategory) return { skipped: 'category' };
    if (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) return { skipped: 'voice' };

    let scanned = 0, deleted = 0, failed = 0;
    let before = null;
    let pages = 0;

    while (true) {
        let batch;
        try {
            batch = await ch.messages.fetch({ limit: 100, before });
        } catch (e) {
            return { error: `fetch: ${e.message}`, scanned, deleted, failed };
        }
        if (!batch.size) break;
        scanned += batch.size;
        pages++;
        const hits = batch.filter(isMee6Message);

        if (hits.size) {
            const now = Date.now();
            const bulk = [], single = [];
            for (const m of hits.values()) {
                if (now - m.createdTimestamp < FOURTEEN_DAYS_MS) bulk.push(m);
                else single.push(m);
            }
            while (bulk.length) {
                const chunk = bulk.splice(0, 100);
                try {
                    const res = await ch.bulkDelete(chunk, true);
                    deleted += res.size;
                } catch (e) {
                    // Fall back to individual deletes if bulk fails (age mismatch, 14d boundary, etc.)
                    single.push(...chunk);
                }
            }
            for (const m of single) {
                try { await m.delete(); deleted++; }
                catch (e) { failed++; }
            }
        }
        before = batch.last().id;
        if (batch.size < 100) break;
        if (pages % 5 === 0) flush('scan', `  ${ch.name}: ${pages} pages, scanned=${scanned}, deleted=${deleted} so far…`);
    }
    return { scanned, deleted, failed, pages };
}

async function collectAllChannels(guild) {
    // Top-level text-capable channels
    const parents = Array.from(guild.channels.cache.values()).filter(c =>
        c.type === ChannelType.GuildText ||
        c.type === ChannelType.GuildAnnouncement ||
        c.type === ChannelType.GuildForum ||
        c.type === ChannelType.GuildMedia
    );

    const result = [];
    for (const p of parents) {
        // Forum / media channels have no direct messages — only threads
        if (p.type !== ChannelType.GuildForum && p.type !== ChannelType.GuildMedia) {
            result.push(p);
        }
        // Active threads
        if (typeof p.threads?.fetchActive === 'function') {
            try {
                const active = await p.threads.fetchActive();
                for (const t of active.threads.values()) result.push(t);
            } catch (e) { /* no thread support on this channel type */ }
        }
        // Archived public threads
        if (typeof p.threads?.fetchArchived === 'function') {
            try {
                const archived = await p.threads.fetchArchived({ type: 'public', limit: 100 });
                for (const t of archived.threads.values()) result.push(t);
            } catch (e) { /* ignore */ }
        }
    }
    return result;
}

async function main() {
    const client = await connectClient();
    const pool = createPool();
    try {
        const guild = await getGuild(client);
        flush('main', `logged in as ${client.user.tag}, guild ${guild.name}`);

        const channels = await collectAllChannels(guild);
        flush('main', `scanning ${channels.length} channels/threads`);

        let totalScanned = 0, totalDeleted = 0, totalFailed = 0;
        const dirty = [];
        for (const ch of channels) {
            const res = await scrub(ch);
            if (res.error) {
                flush('scan', `  ${ch.name} (${ch.id}): ERROR ${res.error} (scanned=${res.scanned}, deleted=${res.deleted})`);
                continue;
            }
            if (res.skipped) {
                flush('scan', `  ${ch.name} (${ch.id}): skip (${res.skipped})`);
                continue;
            }
            totalScanned += res.scanned;
            totalDeleted += res.deleted;
            totalFailed  += res.failed || 0;
            const line = `  ${ch.name} (${ch.id}): scanned=${res.scanned}, deleted=${res.deleted}, failed=${res.failed || 0}, pages=${res.pages}`;
            if (res.deleted > 0 || res.failed > 0) {
                dirty.push({ name: ch.name, id: ch.id, ...res });
                flush('scan', line);
            } else {
                // Log clean channels too so user knows we scanned them
                flush('scan', line);
            }
        }

        flush('sum', `TOTAL scanned=${totalScanned}, deleted=${totalDeleted}, failed=${totalFailed}`);
        if (dirty.length) {
            flush('sum', `channels with hits: ${dirty.length}`);
            for (const d of dirty) flush('sum', `  ${d.name} (${d.id}): deleted=${d.deleted}, failed=${d.failed}`);
        } else {
            flush('sum', 'no MEE6 content found in any scanned channel');
        }

        // Webhooks
        try {
            const webhooks = await guild.fetchWebhooks();
            let webhookHits = 0;
            for (const w of webhooks.values()) {
                if (/mee6/i.test(w.name || '') || w.owner?.id === MEE6_USER_ID) {
                    await w.delete('MEE6 cleanup v2').catch(() => {});
                    webhookHits++;
                    flush('wh', `deleted ${w.name} (${w.id})`);
                }
            }
            flush('wh', `webhook sweep: ${webhookHits} removed`);
        } catch (e) { flush('wh', `fetch failed: ${e.message}`); }

        // Integrations
        try {
            const integrations = await guild.fetchIntegrations();
            let intHits = 0;
            for (const i of integrations.values()) {
                const appId = i.application?.id || i.account?.id;
                if (/mee6/i.test(i.name || '') || appId === MEE6_USER_ID) {
                    await client.rest.delete(`/guilds/${GUILD_ID}/integrations/${i.id}`).catch(() => {});
                    intHits++;
                    flush('int', `deleted ${i.name} (${i.id})`);
                }
            }
            flush('int', `integration sweep: ${intHits} removed`);
        } catch (e) { flush('int', `fetch failed: ${e.message}`); }

        // Membership
        const stillMember = await guild.members.fetch(MEE6_USER_ID).catch(() => null);
        if (stillMember) {
            flush('mem', `MEE6 still in guild — kicking`);
            await stillMember.kick('MEE6 cleanup v2').catch(e => flush('mem', `kick failed: ${e.message}`));
        } else {
            flush('mem', 'MEE6 not a member ✓');
        }
    } finally {
        try { await client.destroy(); } catch (_) {}
        try { await pool.end(); } catch (_) {}
    }
}

main().catch(err => { process.stdout.write(`FATAL ${err?.stack || err}\n`); process.exit(1); });
