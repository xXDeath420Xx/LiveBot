import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder } from 'discord.js';

/*
 * H-719: the Embed theme page's footer (guild_theme.footer_text / footer_icon_url) was saved but only Send test used
 * it. It is now added to the bot's command replies (slash and typed), on embeds in the theme's colours that have no
 * footer of their own (core/guild-theme.js applyThemeFooter / themeReplies).
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h719-'));
process.env.LOG_DIR = tmp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pool = (await import('../utils/db.js')).default;
const theme = await import('../core/guild-theme.js');

const GUILD = '900000000000000719';
const PLAIN = '900000000000000720';   // themed colours, no footer text

test.before(async () => {
    await pool.execute('DELETE FROM guild_theme WHERE guild_id IN (?, ?)', [GUILD, PLAIN]);
    await pool.execute("INSERT INTO guild_theme (guild_id, primary_color, footer_text, footer_icon_url, enabled) VALUES (?, '#112233', 'Be kind', 'https://example.test/i.png', 1)", [GUILD]);
    await pool.execute("INSERT INTO guild_theme (guild_id, primary_color, enabled) VALUES (?, '#112233', 1)", [PLAIN]);
    await theme.loadThemes();
});
test.after(async () => {
    await pool.execute('DELETE FROM guild_theme WHERE guild_id IN (?, ?)', [GUILD, PLAIN]);
    await pool.end().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
});

const footerOf = (e) => (e.toJSON ? e.toJSON() : e).footer;

test('themed embeds without a footer get the server footer and icon', () => {
    const builder = new EmbedBuilder().setColor(theme.themeColor(GUILD, 'primary')).setTitle('Hi');
    const plain = { title: 'Plain', color: parseInt(theme.themeColor(GUILD, 'success').slice(1), 16) };   // a default slot
    const out = theme.applyThemeFooter(GUILD, { content: 'x', embeds: [builder, plain] });
    assert.deepEqual(footerOf(out.embeds[0]), { text: 'Be kind', icon_url: 'https://example.test/i.png' });
    assert.equal(footerOf(out.embeds[1]).text, 'Be kind');
    assert.equal(out.content, 'x');
    assert.equal(builder.data.footer, undefined, 'the caller\'s embed is not changed');
});

test('embeds with their own footer, other colours or no colour, and servers without footer text, are left alone', () => {
    const own = new EmbedBuilder().setColor(theme.themeColor(GUILD, 'primary')).setFooter({ text: 'Page 1/3' });
    const other = new EmbedBuilder().setColor(0xabcdef);
    const none = new EmbedBuilder().setTitle('no colour');
    const opts = { embeds: [own, other, none] };
    assert.equal(theme.applyThemeFooter(GUILD, opts), opts);
    const themed = { embeds: [new EmbedBuilder().setColor(theme.themeColor(PLAIN, 'primary'))] };
    assert.equal(theme.applyThemeFooter(PLAIN, themed), themed);
    assert.equal(theme.applyThemeFooter(GUILD, 'text only'), 'text only');
    assert.equal(theme.applyThemeFooter(null, themed), themed);
});

test('themeReplies puts it on reply, editReply and followUp of a command', async () => {
    const seen = [];
    const interaction = {
        guildId: GUILD,
        reply: async (o) => { seen.push(['reply', o]); },
        editReply: async (o) => { seen.push(['editReply', o]); },
        followUp: async (o) => { seen.push(['followUp', o]); },
    };
    assert.equal(theme.themeReplies(interaction), true);
    assert.equal(theme.themeReplies(interaction), false, 'wrapped once');
    const embed = () => new EmbedBuilder().setColor(theme.themeColor(GUILD, 'danger'));
    await interaction.reply({ embeds: [embed()] });
    await interaction.editReply({ embeds: [embed()] });
    await interaction.followUp({ embeds: [embed()] });
    assert.deepEqual(seen.map(([m, o]) => [m, footerOf(o.embeds[0]).text]), [['reply', 'Be kind'], ['editReply', 'Be kind'], ['followUp', 'Be kind']]);
    assert.equal(theme.themeReplies({ guildId: PLAIN, reply: async () => {} }), false, 'no footer text: nothing to add');
});

test('slash, right-click and typed commands all run through it, and the page says so', () => {
    const events = read('events/interactionCreate.js');
    assert.equal((events.match(/themeReplies\(interaction\);[^\n]*\n\s*try \{\n\s*await command\.execute\(interaction\);/g) || []).length, 2);
    assert.match(read('core/universal-commands.js'), /themeReplies\(ctx\);/);
    const page = read('dashboard/views/partials/manage/theme.ejs');
    assert.doesNotMatch(page, /do not add it yet/);
    assert.match(page, /Added to the bot's replies to commands/);
});
