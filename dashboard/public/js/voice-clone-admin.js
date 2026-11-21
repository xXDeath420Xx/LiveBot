/* Owner console: Your voice (/super-admin/voice; views/super-admin-voice.ejs). Text is set with textContent only. */
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const API = '/api/super-admin/voice';
    const fmt = (d) => (d ? new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');
    function h(tag, attrs, ...kids) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, String(v)); }
        for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
        return el;
    }
    function say(text, bad) { const m = $('vc-msg'); m.textContent = text || ''; m.className = 'vc-msg' + (bad ? ' is-bad' : ' is-ok'); }
    async function call(path, { method = 'POST', body = null, raw = null } = {}) {
        const headers = { accept: 'application/json' };
        let payload = null;
        if (raw) { payload = raw; headers['content-type'] = 'application/octet-stream'; } else if (body) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
        const r = await fetch(API + path, { method, credentials: 'same-origin', headers, body: payload });
        const j = (r.headers.get('content-type') || '').includes('application/json') ? await r.json() : { ok: false, error: 'Session expired: reload.' };
        if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
    }
    const table = (heads, rows) => (rows.length ? h('div', { class: 'cf-table-wrap' }, h('table', { class: 'vc-table' }, h('thead', null, h('tr', null, heads.map((x) => h('th', null, x)))), h('tbody', null, rows))) : h('p', { class: 'cf-muted' }, 'None.'));
    const btn = (label, fn, cls = 'btn btn-secondary btn-sm') => h('button', { type: 'button', class: cls, onclick: fn }, label);

    async function act(path, confirmText, body) {
        if (confirmText && !confirm(confirmText)) return;
        try { await call(path, { body: body || {} }); say('Done.'); load(); } catch (err) { say(err.message, true); }
    }

    function render(d) {
        $('vc-health').textContent = (d.sidecar ? 'Voice checker running.' : 'Voice checker NOT running (pm2 voice-sidecar).') + ' Thresholds: ' + d.thresholds + '.';
        $('vc-invites').replaceChildren(table(['Discord ID', 'Note', 'Invited', 'Status', ''], d.invites.map((i) => h('tr', null,
            h('td', null, h('code', null, i.user_id)), h('td', null, i.note || ''), h('td', null, fmt(i.created_at)),
            h('td', null, i.revoked_at ? 'Withdrawn ' + fmt(i.revoked_at) : 'Invited'),
            h('td', null, i.revoked_at ? '' : btn('Withdraw', () => act('/invites/' + i.user_id + '/revoke', 'Withdraw this invite? Their voice is deleted too.')))))));
        $('vc-voices').replaceChildren(table(['Owner', 'Status', 'Watermark', 'Created', 'Trained', 'Approvals', ''], d.voices.map((v) => h('tr', null,
            h('td', null, h('code', null, v.owner), h('br'), v.name),
            h('td', null, v.status + (v.deleteReason ? ' (' + v.deleteReason + ')' : ''), v.reviewNote ? h('div', { class: 'cf-muted' }, v.reviewNote) : null),
            h('td', null, h('code', null, String(v.wmId))), h('td', null, fmt(v.createdAt)), h('td', null, fmt(v.trainedAt)),
            h('td', null, (v.userApproved ? 'owner of voice: yes' : 'owner of voice: no') + ', you: ' + (v.adminApproved ? 'yes' : 'no')),
            h('td', null, v.status === 'deleted' ? '' : h('div', { class: 'vc-buttons' },
                v.status === 'review' && !v.adminApproved ? btn('Approve', () => act('/voices/' + v.id + '/approve', 'Approve this voice? Listen to it with its owner first.'), 'btn btn-primary btn-sm') : null,
                v.reviewNote && v.reviewNote.startsWith('review:') ? btn('Allow training', () => act('/voices/' + v.id + '/allow-training', 'The recordings were in the review band. Allow training?')) : null,
                v.status === 'suspended' ? btn('Unsuspend', () => act('/voices/' + v.id + '/unsuspend')) : btn('Suspend', () => act('/voices/' + v.id + '/suspend', 'Suspend this voice? It stops at once.', { note: prompt('Reason (optional)') || null })),
                btn('Delete', () => act('/voices/' + v.id + '/delete', 'Delete this voice for good? Files, model, voiceprint and key go now.'), 'btn btn-danger btn-sm')))))));
        $('vc-legacy').replaceChildren(...d.voices.filter((v) => v.legacyVoiceId && v.status !== 'deleted').map(legacyCard));
        $('vc-jobs').replaceChildren(table(['Job', 'Voice', 'State', 'Progress', 'Created', 'Purge receipt', 'Error'], d.jobs.map((j) => h('tr', null,
            h('td', null, String(j.id)), h('td', null, h('code', null, j.voice_id)), h('td', null, j.state + (j.pause_reason ? ' (' + j.pause_reason + ')' : '')),
            h('td', null, j.total_steps ? j.step + ' / ' + j.total_steps : ''), h('td', null, fmt(j.created_at)), h('td', null, j.purge_receipt_at ? fmt(j.purge_receipt_at) : 'none'),
            h('td', null, j.error || '')))));
        $('vc-events').replaceChildren(table(['When', 'Event', 'Who', 'Voice', 'Detail'], d.events.map((e) => h('tr', null,
            h('td', null, fmt(e.created_at)), h('td', null, e.event), h('td', null, e.actor + (e.user_id ? ' ' + e.user_id : '')), h('td', null, e.voice_id ? h('code', null, e.voice_id) : ''),
            h('td', null, e.detail ? JSON.stringify(e.detail).slice(0, 220) : '')))));
    }
    function legacyCard(v) {
        const c = v.consent || {};
        const text = h('input', { type: 'text', value: 'Hello everyone, welcome back to the stream.', 'aria-label': 'Sample text', maxlength: '300' });
        const player = h('audio', { controls: true });
        const play = (which) => async () => {
            try {
                const r = await fetch(API + '/voices/' + v.id + '/sample?which=' + which + '&text=' + encodeURIComponent(text.value), { credentials: 'same-origin' });
                if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
                player.src = URL.createObjectURL(await r.blob()); player.play();
            } catch (err) { say(err.message, true); }
        };
        const opt = (which, cur, label) => btn(label + ': ' + (cur?.on ? 'on' : 'off') + (cur?.by ? ' (set by ' + cur.by + ')' : ''), () => act('/voices/' + v.id + '/optin', 'Turn ' + (cur?.on ? 'off' : 'on') + ' "' + label + '" for this voice? It is recorded as set by you.', { which, on: !cur?.on }));
        return h('div', { class: 'cf-row cf-row--stack' },
            h('p', { class: 'cf-row-label' }, v.name + ' (piper voice "' + v.legacyVoiceId + '", ' + v.status + ')'),
            h('p', { class: 'cf-row-desc' }, 'Consent: ' + (c.method || '?') + (c.complete ? ', recorded' : ', PENDING') + (c.attested ? ', 18+ and residence (' + c.state + ') attested' : ', 18+ and residence NOT attested') + (c.withdrawn ? ', WITHDRAWN' : '') + (c.evidence?.length ? ', ' + c.evidence.length + ' screenshot(s)' : '')),
            h('div', { class: 'vc-inline' }, text, btn('Play current', play('current')), v.hasModel ? btn('Play new', play('new')) : h('span', { class: 'cf-muted' }, 'No new model yet'), player),
            h('div', { class: 'vc-buttons' }, opt('viewerText', v.viewerText, "Other people's messages"), opt('iSaid', v.iSaid, '"I said"'),
                btn('Queue retraining', () => act('/voices/' + v.id + '/queue', 'Queue retraining from the stored recordings?'))));
    }

    async function load() { try { render(await call('', { method: 'GET' })); } catch (err) { say(err.message, true); } }

    $('vc-invite').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await call('/invites', { body: { userId: $('vc-invite-id').value.trim(), note: $('vc-invite-note').value.trim() || null } }); $('vc-invite-id').value = ''; $('vc-invite-note').value = ''; say('Invited.'); load(); }
        catch (err) { say(err.message, true); }
    });
    $('vc-detect').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = $('vc-detect-file').files[0];
        const out = $('vc-detect-result');
        if (!f) return;
        out.textContent = 'Checking…';
        try {
            const r = (await call('/detect', { raw: f })).result;
            out.textContent = r.madeByCertiFried
                ? 'Made by CertiFried (confidence ' + r.confidence + '). Watermark ' + r.wmId + (r.voice ? ': voice ' + r.voice.id + ' of ' + r.voice.owner + ' (' + r.voice.status + ').' : ': no voice has that watermark.')
                : 'No CertiFried watermark found (confidence ' + r.confidence + '). Marks may not survive heavy re-encoding.';
        } catch (err) { out.textContent = err.message; }
    });
    load();
})();
