import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * H-665: /manage welcome test drew an older 1024x450 "WELCOME" card that ignored the dashboard's
 * background, title and subtitle; set-welcome stored the Discord attachment link as the background
 * (it expires); and leaving enable-banner out turned the banner off.
 */
const { renderWelcomePost } = await import('../core/greeting-manager.js');
const { handleTest, handleSetWelcome } = await import('../commands/community/manage-welcome-handler.js');
const { checkBackground, storeWelcomeBackground } = await import('../core/welcome-background.js');
const { default: pool } = await import('../utils/db.js');

const GUILD = '100000000000000665';

function fakeMember() {
    const guild = { id: GUILD, name: 'Maple Hollow', memberCount: 42, channels: { cache: new Map() } };
    return {
        id: '200000000000000665',
        displayName: 'Bramble',
        nickname: null,
        user: {
            id: '200000000000000665', username: 'bramble', globalName: 'Bramble', tag: 'bramble', bot: false,
            displayAvatarURL: () => 'http://127.0.0.1:9/avatar.png',
        },
        guild,
        roles: { cache: new Map() },
        toString() { return `<@${this.id}>`; },
    };
}

test('the welcome post uses the server\'s card title and subtitle', async () => {
    const config = {
        channel_id: '300000000000000665', message: 'Welcome {user}!', banner_enabled: 1, message_type: 'embed',
        card_style: 'dark', card_title_text: 'Hello {user}', card_subtitle_text: 'You are number {memberCount}',
    };
    const post = await renderWelcomePost(fakeMember(), config, { preview: true });
    assert.equal(post.banner, true);
    const file = post.payload.files[0];
    assert.match(file.description, /Hello Bramble/);
    assert.match(file.description, /You are number 42/);
    assert.equal(post.payload.embeds.length, 1);
});

test('/manage welcome test shows that post, not the old WELCOME card', async (t) => {
    t.after(() => pool.execute('DELETE FROM welcome_settings WHERE guild_id = ?', [GUILD]));
    await pool.execute(
        `INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled, message_type, card_title_text, card_subtitle_text)
         VALUES (?, '300000000000000665', 'Welcome {user}!', 1, 'text', 'Glad you came, {user}', 'Member {memberOrdinal}')`, [GUILD]);
    let reply;
    const member = fakeMember();
    await handleTest({
        guild: member.guild, guildId: GUILD, member,
        deferReply: async () => {}, editReply: async (r) => { reply = r; },
    });
    assert.ok(reply && typeof reply === 'object', 'replied with a post');
    assert.match(reply.content, /Preview of the welcome post for <#300000000000000665>/);
    assert.match(reply.content, /Welcome bramble!/);
    const file = reply.files[0];
    assert.match(file.description, /Glad you came, Bramble/);
    assert.match(file.description, /Member 42nd/);
    assert.doesNotMatch(file.description, /"WELCOME"/);
    assert.deepEqual(reply.allowedMentions, { parse: [] });
});

function setWelcomeInteraction({ banner = null, attachment = null } = {}) {
    const member = fakeMember();
    const out = {};
    return {
        out,
        interaction: {
            guild: member.guild, guildId: GUILD, member,
            options: {
                getChannel: () => ({ id: '300000000000000666', toString: () => '<#300000000000000666>' }),
                getString: () => 'Hi {mention}',
                getBoolean: () => banner,
                getAttachment: () => attachment,
            },
            deferReply: async () => {}, editReply: async (r) => { out.reply = r; },
        },
    };
}

test('set-welcome without enable-banner keeps the banner setting', async (t) => {
    t.after(() => pool.execute('DELETE FROM welcome_settings WHERE guild_id = ?', [GUILD]));
    await pool.execute(`INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled) VALUES (?, '300000000000000665', 'x', 1)`, [GUILD]);

    await handleSetWelcome(setWelcomeInteraction().interaction);
    let [[row]] = await pool.execute('SELECT channel_id, message, banner_enabled FROM welcome_settings WHERE guild_id = ?', [GUILD]);
    assert.equal(row.channel_id, '300000000000000666');
    assert.equal(row.message, 'Hi {mention}');
    assert.equal(Number(row.banner_enabled), 1, 'still on');

    await handleSetWelcome(setWelcomeInteraction({ banner: false }).interaction);
    [[row]] = await pool.execute('SELECT banner_enabled FROM welcome_settings WHERE guild_id = ?', [GUILD]);
    assert.equal(Number(row.banner_enabled), 0, 'turned off when asked');
});

test('set-welcome refuses a GIF background and anything over 5 MB', async () => {
    assert.equal(checkBackground({ contentType: 'image/png', name: 'a.png', size: 1000 }).ok, true);
    assert.equal(checkBackground({ contentType: 'image/jpeg', name: 'a.jpeg', size: 1000 }).ext, '.jpg');
    assert.equal(checkBackground({ contentType: 'image/gif', name: 'a.gif', size: 1000 }).ok, false);
    assert.equal(checkBackground({ contentType: 'image/png', name: 'a.png', size: 6 * 1024 * 1024 }).ok, false);

    const { interaction, out } = setWelcomeInteraction({ attachment: { url: 'https://cdn.example/a.gif', contentType: 'image/gif', name: 'a.gif', size: 10 } });
    await handleSetWelcome(interaction);
    assert.match(out.reply, /PNG or JPG/);
});

test('a background is saved as an upload and stored as a lasting /uploads/ link', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbg-'));
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => png });
    const { filename, url } = await storeWelcomeBackground(GUILD,
        { url: 'https://cdn.discordapp.com/attachments/1/2/bg.png?ex=abc', contentType: 'image/png', name: 'bg.png', size: png.length },
        { dir, fetchImpl });
    assert.match(filename, new RegExp(`^welcome_${GUILD}_\\d+\\.png$`));
    assert.match(url, /\/uploads\/welcome_100000000000000665_\d+\.png$/);
    assert.doesNotMatch(url, /discordapp/);
    assert.deepEqual(fs.readFileSync(path.join(dir, filename)), png);
    fs.rmSync(dir, { recursive: true, force: true });
});
