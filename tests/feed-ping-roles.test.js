// Ping roles for the Twitch clip feeds and the Fortnite feed (migration 480), like the other feed types.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { normalizePingRole, PING_ROLE_ERROR } from '../core/feed-ping.js';
import { buildFeedContent } from '../core/feed-message.js';

const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ROLE = '123456789012345678';
const guild = { id: '999999999999999999', roles: { cache: new Map([[ROLE, {}]]) } };

test('a ping role is a role of the server, everyone, or nothing', () => {
    assert.equal(normalizePingRole('', guild), null);
    assert.equal(normalizePingRole(null, guild), null);
    assert.equal(normalizePingRole('everyone', guild), 'everyone');
    assert.equal(normalizePingRole(` ${ROLE} `, guild), ROLE);
    assert.throws(() => normalizePingRole('876543210987654321', guild), { message: PING_ROLE_ERROR });
    assert.throws(() => normalizePingRole(guild.id, guild), { message: PING_ROLE_ERROR });   // @everyone's own id
    assert.throws(() => normalizePingRole('<@&123>', guild), { message: PING_ROLE_ERROR });
    assert.equal(normalizePingRole(ROLE, null), ROLE);   // no live guild: the shape is all that can be checked
});

test('the post lets through exactly the chosen ping', () => {
    assert.deepEqual(buildFeedContent({ template: null, vars: {}, pingRoleId: ROLE }),
        { content: `<@&${ROLE}>`, allowedMentions: { parse: [], roles: [ROLE] } });
    assert.deepEqual(buildFeedContent({ template: null, vars: {}, pingRoleId: null }), { content: undefined, allowedMentions: undefined });
});

test('both checkers send the feed ping with each post', () => {
    const clips = read('jobs/twitch-clip-checker.js');
    assert.match(clips, /buildFeedContent\(\{ template: null, vars: \{\}, pingRoleId: feed\.ping_role_id \}\)/);
    assert.match(clips, /channel\.send\(\{ content, allowedMentions, embeds: \[clipEmbed/);
    const fn = read('jobs/fortnite-feed-checker.js');
    assert.match(fn, /pingRoleId: feed\.ping_role_id/);
    assert.match(fn, /channel\.send\(\{ content: ping\.content, allowedMentions: ping\.allowedMentions, embeds: \[embed\] \}\)/);
});

test('the clip API and the Social feeds API accept ping_role_id', () => {
    const api = read('dashboard/routes/api/features/twitch-clips.js');
    assert.match(api, /pingRoleId: b\.ping_role_id/);
    assert.match(api, /changes\.pingRoleId = b\.ping_role_id/);
    const feeds = read('dashboard/routes/api/features/feeds.js');
    assert.match(feeds, /fortnite: \{\s+table: 'fortnite_feeds', channelCol: 'channel_id',\s+fields: \{\s+ping_role_id: \{ col: 'ping_role_id', type: 'ping' \}/);
});

test('the Twitch clips page has a ping selector in the add form and in each feed', () => {
    const ejs = require('ejs');
    const file = new URL('../dashboard/views/partials/manage/twitch-clips.ejs', import.meta.url).pathname;
    const html = ejs.render(fs.readFileSync(file, 'utf8'), {
        guild: { id: '1', members: {} }, channels: [{ id: '2', name: 'clips', type: 0 }],
        roles: [{ id: ROLE, name: 'Clip fans', mentionable: true }],
    }, { filename: file });
    assert.match(html, /<select class="form-select" id="tc-ping">/);
    assert.match(html, new RegExp(`<option value="${ROLE}" data-kind="role">@Clip fans</option>`));
    assert.match(html, /ping_role_id: document\.getElementById\('tc-ping'\)\.value/);
    assert.match(html, /field\('Ping role', pingSelect\(f\.ping_role_id\)\)/);
});

test('the Social feeds page lists a Fortnite feed with the ping selector', () => {
    const ejs = require('ejs');
    const file = new URL('../dashboard/views/partials/manage/feeds.ejs', import.meta.url).pathname;
    const html = ejs.render(fs.readFileSync(file, 'utf8'), {
        guild: { id: '1', members: {} }, guildId: '1', channels: [{ id: '2', name: 'fortnite', type: 0 }],
        redditFeeds: [], youtubeFeeds: [], twitterFeeds: [], blueskyFeeds: [], rssFeeds: [],
        fortniteFeeds: [{ id: 7, guild_id: '1', channel_id: '2', sources: '["epic_news","shop"]', enabled: 1, ping_role_id: ROLE }],
        roles: [{ id: ROLE, name: 'Fortnite', mentionable: true }],
    }, { filename: file });
    assert.match(html, /id="fd-fortnite-title"/);
    assert.match(html, /Epic news, Item shop/);
    assert.match(html, /data-feed-kind="fortnite" data-feed-id="7"/);
    assert.match(html, new RegExp(`<option value="${ROLE}"[^>]*selected>@Fortnite</option>`));
    assert.match(html, /Pings @Fortnite/);
    // no message template for this feed type
    const panel = html.slice(html.indexOf('data-feed-kind="fortnite" data-feed-id="7">'));
    assert.doesNotMatch(panel.slice(0, panel.indexOf('</tr>')), /data-f="custom_message"/);
});

test('without a Fortnite feed the section is not shown', () => {
    const ejs = require('ejs');
    const file = new URL('../dashboard/views/partials/manage/feeds.ejs', import.meta.url).pathname;
    const html = ejs.render(fs.readFileSync(file, 'utf8'), {
        guild: { id: '1', members: {} }, guildId: '1', channels: [], redditFeeds: [], youtubeFeeds: [], twitterFeeds: [], roles: [],
    }, { filename: file });
    assert.doesNotMatch(html, /fd-fortnite-title/);
});
