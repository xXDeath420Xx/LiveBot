// Post an exhaustive, auto-generated command reference into a channel. Source of truth
// is the bot's REGISTERED slash-command tree (GET .../commands) — every command,
// subcommand group, subcommand, and its description. REST-only; posts as the bot that
// owns the channel.
//
//   node scripts/post-command-reference.mjs            # dry run (prints structure + sizes)
//   node scripts/post-command-reference.mjs --post     # actually post
//   node scripts/post-command-reference.mjs --post --clean   # delete our prior dump first

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const CHANNEL_ID = '1470675898662654002';        // ℭ𝔬𝔪𝔪𝔞𝔫𝔡𝔰 (Forsaken Warriors)
const POST = process.argv.includes('--post');
const CLEAN = process.argv.includes('--clean');

const HEADER_TITLE = '📖 CertiFried — Full Command Reference';
const COLOR = 0xF0A500;

// Discord limits (with safety margin)
const MAX_EMBED_DESC = 3900;     // hard 4096
const MAX_MSG_TOTAL = 5500;      // hard 6000 across all embeds in one message
const MAX_EMBEDS_PER_MSG = 6;    // hard 10

async function rest(token, method, url, body) {
    for (let i = 0; i < 8; i++) {
        const headers = { Authorization: 'Bot ' + token };
        if (body) headers['Content-Type'] = 'application/json';
        const init = { method, headers };
        if (body) init.body = JSON.stringify(body);
        const r = await fetch(url, init);
        if (r.status === 429) { const b = await r.json().catch(() => ({ retry_after: 1 })); await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 250)); continue; }
        if (r.status === 404) return { __notfound: true };
        if (!r.ok) return { __error: r.status, body: (await r.text().catch(() => '')).slice(0, 200) };
        return r.status === 204 ? { __ok: true } : r.json();
    }
    return { __error: 'retries' };
}

// Build a markdown block (string) for one top-level command.
function blockFor(cmd) {
    const lines = [`**/${cmd.name}** — ${cmd.description || ''}`.trimEnd()];
    const opts = cmd.options || [];
    const subs = opts.filter(o => o.type === 1);        // SUB_COMMAND
    const groups = opts.filter(o => o.type === 2);       // SUB_COMMAND_GROUP
    const params = opts.filter(o => o.type > 2);          // value options on a base command

    if (params.length && !subs.length && !groups.length) {
        const p = params.map(o => o.required ? `<${o.name}>` : `[${o.name}]`).join(' ');
        if (p) lines[0] = `**/${cmd.name} ${p}** — ${cmd.description || ''}`.trimEnd();
    }
    for (const s of subs) {
        lines.push(` • \`/${cmd.name} ${s.name}\` — ${s.description || ''}`.trimEnd());
    }
    for (const g of groups) {
        lines.push(` ▸ **${g.name}**`);
        for (const s of (g.options || [])) {
            lines.push(`  • \`/${cmd.name} ${g.name} ${s.name}\` — ${s.description || ''}`.trimEnd());
        }
    }
    return lines.join('\n');
}

// Split an over-long block on line boundaries so no piece exceeds MAX_EMBED_DESC.
function splitBlock(block) {
    if (block.length <= MAX_EMBED_DESC) return [block];
    const out = [];
    let cur = '';
    for (const line of block.split('\n')) {
        if (cur && (cur.length + 1 + line.length) > MAX_EMBED_DESC) { out.push(cur); cur = line; }
        else cur = cur ? cur + '\n' + line : line;
    }
    if (cur) out.push(cur);
    return out;
}

async function main() {
    // Resolve Kitsune token (owns the channel).
    const [[row]] = [await pool.execute("SELECT bot_id, bot_token FROM custom_bots WHERE bot_id = '1498486251576229958'")];
    const bot = row[0];
    const token = encryption.decrypt(JSON.parse(bot.bot_token));
    const me = await rest(token, 'GET', 'https://discord.com/api/v10/users/@me');
    const ch = await rest(token, 'GET', `https://discord.com/api/v10/channels/${CHANNEL_ID}`);
    const guildId = ch.guild_id;
    console.log(`Bot: ${me.username} (${me.id}) | channel #${ch.name} | guild ${guildId}`);

    const cmds = await rest(token, 'GET', `https://discord.com/api/v10/applications/${me.id}/guilds/${guildId}/commands`);
    if (!Array.isArray(cmds)) { console.error('could not fetch commands', cmds); process.exit(1); }
    cmds.sort((a, b) => a.name.localeCompare(b.name));
    const subCount = cmds.reduce((n, c) => n + (c.options || []).filter(o => o.type === 1).length + (c.options || []).filter(o => o.type === 2).reduce((m, g) => m + (g.options || []).length, 0), 0);
    console.log(`Commands: ${cmds.length} top-level, ${subCount} subcommands\n`);

    // 1) build blocks
    const blocks = [];
    for (const c of cmds) for (const piece of splitBlock(blockFor(c))) blocks.push(piece);

    // 2) pack blocks into embed descriptions (≤ MAX_EMBED_DESC each)
    const embeds = [{ title: HEADER_TITLE, color: COLOR,
        description: `Every slash command available here — **${cmds.length} commands**, **${subCount} subcommands**. Type \`/\` in chat to use any of them, or \`/help\` for an interactive explorer.` }];
    let cur = '';
    for (const b of blocks) {
        if (cur && (cur.length + 2 + b.length) > MAX_EMBED_DESC) { embeds.push({ color: COLOR, description: cur }); cur = b; }
        else cur = cur ? cur + '\n\n' + b : b;
    }
    if (cur) embeds.push({ color: COLOR, description: cur });
    embeds[embeds.length - 1].footer = { text: 'certifriedmultitool.com • /help for an interactive explorer' };

    // 3) group embeds into messages (≤ MAX_EMBEDS_PER_MSG and ≤ MAX_MSG_TOTAL chars)
    const messages = [];
    let mEmbeds = [], mChars = 0;
    for (const e of embeds) {
        const len = (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length;
        if (mEmbeds.length && (mEmbeds.length >= MAX_EMBEDS_PER_MSG || mChars + len > MAX_MSG_TOTAL)) { messages.push(mEmbeds); mEmbeds = []; mChars = 0; }
        mEmbeds.push(e); mChars += len;
    }
    if (mEmbeds.length) messages.push(mEmbeds);

    console.log(`Will send ${messages.length} message(s), ${embeds.length} embed(s) total.`);
    messages.forEach((m, i) => console.log(`  msg ${i + 1}: ${m.length} embed(s), ${m.reduce((n, e) => n + (e.description || '').length, 0)} chars`));

    if (!POST) {
        console.log('\n--- PREVIEW (first 2 embeds) ---');
        embeds.slice(0, 2).forEach(e => console.log('\n' + (e.title ? `# ${e.title}\n` : '') + (e.description || '').slice(0, 700) + ((e.description || '').length > 700 ? '\n…' : '')));
        console.log('\nDRY RUN — re-run with --post to publish.');
        await pool.end(); process.exit(0);
    }

    if (CLEAN) {
        const recent = await rest(token, 'GET', `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?limit=50`);
        const ours = (Array.isArray(recent) ? recent : []).filter(m => m.author?.id === me.id && (m.embeds || []).some(e => e.title === HEADER_TITLE || (e.description || '').includes('/help')));
        for (const m of ours) { await rest(token, 'DELETE', `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${m.id}`); }
        if (ours.length) console.log(`Cleaned ${ours.length} prior message(s).`);
    }

    let sent = 0;
    for (const m of messages) {
        const res = await rest(token, 'POST', `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, { embeds: m });
        if (res && !res.__error) { sent++; console.log(`  ✓ sent message ${sent}/${messages.length} (${res.id})`); }
        else { console.error(`  ! failed:`, res); }
        await new Promise(r => setTimeout(r, 600));
    }
    console.log(`\nPosted ${sent}/${messages.length} message(s) to #${ch.name}.`);
    await pool.end(); process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
