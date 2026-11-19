import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import { qotdSwitchOn } from '../core/qotd-poster.js';

/*
 * Levels & engagement pages, accuracy pass 2026-11-19:
 *  - the Question of the Day page's Enabled switch was read by nothing; the scheduler now skips a
 *    server that turned it off (core/qotd-poster.js qotdSwitchOn / qotdEnabledFor, jobs/qotd-scheduler.js);
 *  - a birthday card's subtitle colour picker was given '#ffffff99', which a colour input reads as
 *    black, so saving the card's options made an unset subtitle black. The picker now shows a valid
 *    colour and the save keeps the stored value when the picker was not changed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('qotd: the Enabled switch is on unless saved off', () => {
    assert.equal(qotdSwitchOn({}), true);
    assert.equal(qotdSwitchOn(null), true);
    assert.equal(qotdSwitchOn({ enabled: 1 }), true);
    assert.equal(qotdSwitchOn({ enabled: true }), true);
    for (const off of [0, false, '0', 'false']) assert.equal(qotdSwitchOn({ enabled: off }), false, String(off));
});

test('qotd: the scheduler checks the switch before posting', () => {
    const src = read('jobs/qotd-scheduler.js');
    const check = src.indexOf('qotdEnabledFor(channelConfig.guild_id)');
    assert.ok(check > 0, 'scheduler calls qotdEnabledFor');
    assert.ok(check < src.indexOf('postQOTD(botClient, channelConfig)'), 'before it posts');
});

function renderBirthday(card) {
    const views = path.join(root, 'dashboard/views');
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-bd-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, 'partials/manage/birthday'))}) %>`);
        return engine.renderFile(file, {
            guild: { id: '222222222222222222', name: 'Acme' },
            channels: [], roles: [], birthdays: [], birthdayStats: { total: 0, thisMonth: 0, upcoming: 0 },
            birthdayConfig: { enabled: 1 },
            birthdayCards: [{ id: 4, slug: 'abc', share_token: 'tok', recipient_id: '800000000000000001', created_at: new Date(), ...card }],
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('birthday card: an unset subtitle colour is shown as a valid colour and marked as shown', () => {
    const html = renderBirthday({ subtitle_font_color: null });
    const picker = html.match(/<input id="f-birthday-subtitle_font_color-4" type="color" name="subtitle_font_color" value="([^"]*)"/);
    assert.ok(picker, 'picker rendered');
    assert.match(picker[1], /^#[0-9a-f]{6}$/i);
    assert.match(html, new RegExp(`name="subtitle_font_color_shown" value="${picker[1]}"`));
});

test('birthday card: a saved subtitle colour is kept on the picker', () => {
    const html = renderBirthday({ subtitle_font_color: '#123abc' });
    assert.match(html, /name="subtitle_font_color" value="#123abc"/);
    assert.match(html, /name="subtitle_font_color_shown" value="#123abc"/);
});

test('birthday card save: an unchanged subtitle colour keeps the stored value', () => {
    const src = read('dashboard/server.js');
    assert.match(src, /subtitle_font_color = COALESCE\(\?, subtitle_font_color\)/);
    assert.match(src, /subtitle_font_color !== req\.body\.subtitle_font_color_shown/);
});
