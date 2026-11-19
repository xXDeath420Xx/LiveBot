/* Windrose Manager (owner console).
 *
 * Every mutating call here is destructive or disruptive in some way, so the
 * pattern throughout is: confirm, disable the control, show what happened.
 * Nothing fires silently.
 */
(function () {
    'use strict';

    var cfg = window.WRM || {};
    var filesPath = '.';

    function $(id) { return document.getElementById(id); }

    function toast(msg, kind) {
        var box = $('toast');
        var el = document.createElement('div');
        el.className = 'toast-item ' + (kind === 'err' ? 'toast-err' : 'toast-ok');
        el.textContent = msg;
        box.appendChild(el);
        setTimeout(function () { el.remove(); }, 7000);
    }

    function api(path, opts) {
        opts = opts || {};
        return fetch(path, {
            method: opts.method || 'GET',
            headers: Object.assign({ 'Content-Type': 'application/json' }, cfg.csrf ? { 'X-CSRF-Token': cfg.csrf } : {}),
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            credentials: 'same-origin'
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
                if (!r.ok) throw new Error(d.error || ('Failed (' + r.status + ')'));
                return d;
            });
        });
    }

    function busy(btn, on, label) {
        if (!btn) return;
        btn.disabled = on;
        if (on) { btn.dataset.html = btn.innerHTML; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> ' + (label || 'Working…'); }
        else if (btn.dataset.html) { btn.innerHTML = btn.dataset.html; }
    }

    function text(el, value) { el.textContent = value == null ? '' : String(value); return el; }
    function cell(row, value, cls) {
        var td = document.createElement('td');
        if (cls) td.className = cls;
        text(td, value);
        row.appendChild(td);
        return td;
    }

    // ------------------------------------------------------------ tabs
    document.querySelectorAll('.tab').forEach(function (t) {
        t.addEventListener('click', function () {
            document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
            document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
            t.classList.add('active');
            $('panel-' + t.dataset.tab).classList.add('active');
            if (LOADERS[t.dataset.tab]) LOADERS[t.dataset.tab]();
            refreshControl();
        });
    });


    // ------------------------------------------------------------ server control
    //
    // Lives in the page header rather than a tab: importing a world, editing
    // world settings and restoring a backup all REQUIRE a stopped server, so
    // the control has to be reachable from whichever tab you are on. Omitting
    // it entirely was the original bug — the import flow told people to stop the
    // server on a page with no stop button.
    function renderControl(s) {
        var running = s && s.container && s.container.running;
        var healthy = s && s.healthy;
        var dot = 'dot-off', label = 'Stopped';
        if (healthy) { dot = 'dot-on'; label = 'Running'; }
        else if (running) { dot = 'dot-warn'; label = 'Starting…'; }

        var el = $('ctl-state');
        if (el) el.innerHTML = '<span class="dot ' + dot + '"></span>' + label;

        var srv = (s && s.server) || {};
        var worldName = (s && s.world && s.world.name) || null;
        var suffix = worldName ? '  ·  ' + worldName : '';
        text($('ctl-players'), (running
            ? (srv.player_count != null ? srv.player_count : '?') + '/' + (srv.max_players || '?') + ' players'
            : 'stopped') + suffix);

        // Only offer what makes sense in the current state.
        if ($('ctl-start')) $('ctl-start').disabled = !!running;
        if ($('ctl-stop')) $('ctl-stop').disabled = !running;
        if ($('ctl-restart')) $('ctl-restart').disabled = !running;
    }

    function refreshControl() {
        api('/windrose/api/status')
            .then(renderControl)
            .catch(function () {
                var el = $('ctl-state');
                if (el) el.innerHTML = '<span class="dot dot-off"></span>Unknown';
            });
    }

    function lifecycle(op, btn) {
        var warn = null;
        if (op === 'stop') warn = 'Stop the server?\n\nAnyone playing is disconnected. Needed before importing a world, restoring a backup, or applying world settings.';
        if (op === 'restart') warn = 'Restart?\n\nPlayers get warnings at 5 minutes and 1 minute, a snapshot is taken, then it bounces.';
        if (warn && !confirm(warn)) return;

        busy(btn, true, op === 'stop' ? 'Stopping…' : op === 'start' ? 'Starting…' : 'Restarting…');
        api('/windrose/api/lifecycle/' + op, { method: 'POST', body: {} })
            .then(function (r) {
                toast(r.note || ('Server ' + op + ' requested.'));
                // The container takes a while to settle; poll rather than
                // reporting a state that is already stale.
                var tries = 0;
                (function poll() {
                    tries++;
                    refreshControl();
                    if (tries < 20) setTimeout(poll, 3000);
                })();
            })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(btn, false); });
    }

    ['start', 'stop', 'restart'].forEach(function (op) {
        var b = $('ctl-' + op);
        if (b) b.addEventListener('click', function () { lifecycle(op, b); });
    });
    if ($('ctl-refresh')) $('ctl-refresh').addEventListener('click', refreshControl);

    // ------------------------------------------------------------ overview
    function loadStats() {
        api('/wrmanager/api/stats').then(function (s) {
            if (!s.running) { text($('s-cpu'), '–'); text($('s-mem'), 'stopped'); return; }
            text($('s-cpu'), s.cpuPercent + '%');
            text($('s-mem'), (s.memUsedBytes / 1073741824).toFixed(2) + ' / ' + Math.round(s.memLimitBytes / 1073741824) + ' GB');
            var bar = $('s-mem-bar');
            bar.style.width = Math.min(100, s.memPercent) + '%';
            // Colour by headroom, not by a fixed threshold: what matters is how
            // close we are to the cap that protects the bot process.
            bar.style.background = s.memPercent > 85 ? 'var(--accent-red)' : s.memPercent > 65 ? 'var(--accent-yellow)' : 'var(--accent-green)';
        }).catch(function (e) { toast(e.message, 'err'); });

        api('/windrose/api/status').then(function (s) {
            var srv = s.server || {};
            text($('s-players'), (srv.player_count != null ? srv.player_count : '–') + ' / ' + (srv.max_players || '–'));
            text($('s-state'), s.healthy ? 'Healthy' : (s.container && s.container.running ? 'Starting' : 'Stopped'));
        }).catch(function () { text($('s-state'), 'Unknown'); });

        api('/wrmanager/api/schedule').then(function (s) {
            text($('sched-status'), s.scheduled ? ('next: ' + new Date(s.nextRunAt).toLocaleString()) : 'no schedule');
        }).catch(function () {});

        api('/wrmanager/api/watchdog').then(function (w) {
            text($('wd-mirror'), (w.mirrorCount != null ? w.mirrorCount : '–') + ' copies');
            text($('wd-swap'), (w.swapGb != null ? w.swapGb : '–') + ' G');
            text($('wd-warn'), (w.warnings || []).length);
            text($('watchdog-when'), w.checkedAt ? 'last check ' + new Date(w.checkedAt).toLocaleString() : 'never run');
            var b = $('watchdog-banner');
            if ((w.warnings || []).length) { b.style.display = ''; text($('watchdog-text'), w.warnings.join(' · ')); }
            else b.style.display = 'none';
        }).catch(function () {});

        api('/wrmanager/api/autoupdate').then(function (a) {
            if ($('auto-toggle')) $('auto-toggle').checked = !!a.enabled;
            var bits = [];
            bits.push(a.enabled ? 'on, every ' + a.intervalMinutes + 'm' : 'off');
            if (a.knownBuildId) bits.push('known build ' + a.knownBuildId);
            if (a.remoteBuildId) bits.push('steam ' + a.remoteBuildId + (a.updateAvailable ? '  ← NEW' : ''));
            if (a.lookupError) bits.push('steam lookup failed: ' + a.lookupError);
            if (a.lastCheckedAt) bits.push('checked ' + new Date(a.lastCheckedAt).toLocaleString());
            if (a.lastResult) bits.push('last: ' + (a.lastResult.updated ? a.lastResult.buildBefore + ' → ' + a.lastResult.buildAfter : 'no change')
                + (a.lastResult.healthy === false ? '  (SERVER DID NOT COME BACK)' : ''));
            text($('auto-status'), bits.join('  ·  '));
        }).catch(function () {});

        api('/wrmanager/api/update').then(function (u) {
            // Game build leads: it is what rejects players, and the image digest
            // tells you nothing about it.
            text($('game-build'), u.gameBuild || 'unknown');
            text($('image-info'), '@' + (u.digest || '?'));
        }).catch(function () {});
    }

    $('stats-refresh').addEventListener('click', loadStats);
    $('logs-refresh').addEventListener('click', function () {
        var btn = $('logs-refresh'); busy(btn, true);
        api('/wrmanager/api/logs?tail=200')
            .then(function (d) { text($('logs-out'), typeof d === 'string' ? d : JSON.stringify(d, null, 2)); })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(btn, false); });
    });

    $('sched-set').addEventListener('click', function () {
        api('/wrmanager/api/schedule', { method: 'POST', body: { hour: +$('sched-hour').value, minute: +$('sched-min').value } })
            .then(function () { toast('Daily restart scheduled.'); loadStats(); })
            .catch(function (e) { toast(e.message, 'err'); });
    });
    $('sched-cancel').addEventListener('click', function () {
        api('/wrmanager/api/schedule', { method: 'POST', body: { cancel: true } })
            .then(function () { toast('Schedule cancelled.'); loadStats(); })
            .catch(function (e) { toast(e.message, 'err'); });
    });

    $('update-check').addEventListener('click', function () {
        var btn = $('update-check'); busy(btn, true, 'Pulling…');
        api('/wrmanager/api/update/check', { method: 'POST', body: {} })
            .then(function (r) {
                $('update-out').style.display = '';
                text($('update-out'), r.output || '');
                toast(r.updateAvailable ? 'Update available — apply it when players are off.' : 'Already up to date.');
            })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(btn, false); });
    });

    if ($('auto-toggle')) $('auto-toggle').addEventListener('change', function () {
        var on = $('auto-toggle').checked;
        api('/wrmanager/api/autoupdate/enabled', { method: 'POST', body: { enabled: on } })
            .then(function () { toast('Auto-update ' + (on ? 'enabled' : 'disabled') + '.'); loadStats(); })
            .catch(function (e) { toast(e.message, 'err'); $('auto-toggle').checked = !on; });
    });

    if ($('auto-check')) $('auto-check').addEventListener('click', function () {
        var b = $('auto-check'); busy(b, true, 'Checking…');
        api('/wrmanager/api/autoupdate/check', { method: 'POST', body: {} })
            .then(function (r) { toast(r.action + (r.reason ? ': ' + r.reason : '')); loadStats(); })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(b, false); });
    });

    if ($('auto-force')) $('auto-force').addEventListener('click', function () {
        if (prompt('Force an update now?\n\nThis SKIPS the players-online and cooldown guards.\n\nType UPDATE to confirm:') !== 'UPDATE') return;
        var b = $('auto-force'); busy(b, true, 'Updating…');
        api('/wrmanager/api/autoupdate/check', { method: 'POST', body: { force: true } })
            .then(function (r) { toast(r.action === 'updated' ? (r.buildBefore + ' → ' + r.buildAfter) : (r.reason || r.action)); loadStats(); })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(b, false); });
    });

    if ($('update-game')) $('update-game').addEventListener('click', function () {
        if (prompt('Update the GAME to the latest Windrose build?\n\n'
            + 'Everyone is disconnected and this may download several GB. A snapshot is taken first.\n\n'
            + 'Type UPDATE to confirm:') !== 'UPDATE') return;

        var btn = $('update-game');
        busy(btn, true, 'Downloading…');
        toast('Update started — this can take a while. Leave this page open.');

        api('/wrmanager/api/update/game', { method: 'POST', body: { confirm: 'UPDATE' } })
            .then(function (r) {
                $('update-out').style.display = '';
                text($('update-out'), (r.output || '') + '\n\n' + (r.note || ''));
                if (r.updated) toast('Game updated: ' + r.buildBefore + ' → ' + r.buildAfter);
                // Honest about the slow case rather than claiming success.
                else toast(r.note || 'No build change detected yet.', 'err');
                loadStats();
            })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(btn, false); });
    });

    $('update-apply').addEventListener('click', function () {
        if (prompt('This recreates the container and disconnects everyone.\nA game update can break Windrose+ compatibility.\n\nType UPDATE to confirm:') !== 'UPDATE') return;
        var btn = $('update-apply'); busy(btn, true, 'Recreating…');
        api('/wrmanager/api/update/apply', { method: 'POST', body: { confirm: 'UPDATE' } })
            .then(function (r) {
                $('update-out').style.display = '';
                text($('update-out'), r.output || '');
                toast(r.recreated ? 'Container recreated on the new image.' : 'Applied — image was already current.');
                loadStats();
            })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(btn, false); });
    });

    // ------------------------------------------------------------ people
    function loadUsers() {
        api('/wrmanager/api/users').then(function (d) {
            var body = $('users-body');
            body.innerHTML = '';
            if (!d.users.length) { body.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted)">No users yet.</td></tr>'; return; }
            d.users.forEach(function (u) {
                var tr = document.createElement('tr');
                cell(tr, u.discord_id, 'mono');
                cell(tr, u.display_name || '—');
                cell(tr, u.role);
                var steam = document.createElement('td');
                var inp = document.createElement('input');
                inp.className = 'mono'; inp.placeholder = '17-digit SteamID64'; inp.style.width = '190px';
                inp.value = u.steam_id || '';
                steam.appendChild(inp); tr.appendChild(steam);
                var act = document.createElement('td');
                var save = document.createElement('button');
                save.className = 'btn btn-sm'; save.textContent = 'Link';
                save.addEventListener('click', function () {
                    api('/wrmanager/api/users/steam', { method: 'POST', body: { discordId: u.discord_id, steamId: inp.value.trim() } })
                        .then(function () { toast('Steam ID saved.'); })
                        .catch(function (e) { toast(e.message, 'err'); });
                });
                act.appendChild(save); tr.appendChild(act);
                body.appendChild(tr);
            });
        }).catch(function (e) { toast(e.message, 'err'); });
    }

    $('grant-go').addEventListener('click', function () {
        api('/wrmanager/api/users/role', { method: 'POST', body: { discordId: $('grant-id').value.trim(), role: $('grant-role').value } })
            .then(function () { toast('Role set.'); loadUsers(); })
            .catch(function (e) { toast(e.message, 'err'); });
    });

    // ------------------------------------------------------------ settings
    var MULTS = ['loot', 'xp', 'craft_efficiency', 'cooking_speed', 'harvest_yield'];
    // Every float the game exposes, with the documented ranges.
    var WORLD = [
        ['WDS.Parameter.MobHealthMultiplier', 'Mob health', 0.2, 5],
        ['WDS.Parameter.MobDamageMultiplier', 'Mob damage', 0.2, 5],
        ['WDS.Parameter.ShipsHealthMultiplier', 'Ship health', 0.4, 5],
        ['WDS.Parameter.ShipsDamageMultiplier', 'Ship damage', 0.2, 2.5],
        ['WDS.Parameter.BoardingDifficultyMultiplier', 'Boarding difficulty', 0.2, 5],
        ['WDS.Parameter.Coop.StatsCorrectionModifier', 'Co-op enemy scaling', 0, 2],
        ['WDS.Parameter.Coop.ShipStatsCorrectionModifier', 'Co-op ship scaling', 0, 2]
    ];
    var WORLD_BOOLS = [
        ['WDS.Parameter.Coop.SharedQuests', 'Shared co-op quests', true],
        ['WDS.Parameter.EasyExplore', 'Immersive exploration (hides markers)', false]
    ];

    function buildSettingsFields(current) {
        var mf = $('mult-fields'); mf.innerHTML = '';
        MULTS.forEach(function (key) {
            var wrap = document.createElement('div'); wrap.className = 'field';
            var lab = document.createElement('label'); lab.textContent = key + (key === 'xp' ? ' (one-way)' : '');
            var inp = document.createElement('input');
            inp.type = 'number'; inp.step = '0.1'; inp.min = '0.1'; inp.max = '10'; inp.style.width = '100%';
            inp.dataset.mult = key;
            inp.value = (current && current.multipliers && current.multipliers[key]) || 1;
            wrap.appendChild(lab); wrap.appendChild(inp); mf.appendChild(wrap);
        });

        var wf = $('world-fields'); wf.innerHTML = '';
        WORLD.forEach(function (w) {
            var wrap = document.createElement('div'); wrap.className = 'field';
            var lab = document.createElement('label'); lab.textContent = w[1] + ' (' + w[2] + '–' + w[3] + ')';
            var inp = document.createElement('input');
            inp.type = 'number'; inp.step = '0.1'; inp.min = String(w[2]); inp.max = String(w[3]); inp.style.width = '100%';
            inp.dataset.world = w[0]; inp.value = 1;
            wrap.appendChild(lab); wrap.appendChild(inp); wf.appendChild(wrap);
        });
        WORLD_BOOLS.forEach(function (b) {
            var wrap = document.createElement('div'); wrap.className = 'field';
            var lab = document.createElement('label'); lab.textContent = b[1];
            var sel = document.createElement('select'); sel.style.width = '100%';
            sel.dataset.worldbool = b[0];
            [['default', '(leave as-is)'], ['true', 'true'], ['false', 'false']].forEach(function (o) {
                var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1]; sel.appendChild(opt);
            });
            wrap.appendChild(lab); wrap.appendChild(sel); wf.appendChild(wrap);
        });

        var diff = document.createElement('div'); diff.className = 'field';
        diff.innerHTML = '<label>Combat difficulty</label>';
        var sel = document.createElement('select'); sel.style.width = '100%'; sel.dataset.world = 'WDS.Parameter.CombatDifficulty';
        ['Easy', 'Normal', 'Hard'].forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });
        sel.value = 'Normal'; diff.appendChild(sel); wf.appendChild(diff);
    }

    function renderPending(pending) {
        var box = $('pending-list');
        box.innerHTML = '';
        if (!pending || !pending.length) { box.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">Nothing staged.</div>'; return; }
        pending.forEach(function (p) {
            var d = document.createElement('div'); d.className = 'pending';
            var head = document.createElement('div');
            head.innerHTML = '<strong>' + p.target_file + '</strong>';
            var pre = document.createElement('div'); pre.className = 'mono'; pre.style.marginTop = '0.35rem';
            text(pre, JSON.stringify(p.patch));
            var del = document.createElement('button');
            del.className = 'btn btn-sm btn-danger'; del.textContent = 'Discard'; del.style.marginTop = '0.5rem';
            del.addEventListener('click', function () {
                api('/wrmanager/api/config/stage/' + p.id, { method: 'DELETE' })
                    .then(function () { toast('Discarded.'); loadSettings(); })
                    .catch(function (e) { toast(e.message, 'err'); });
            });
            d.appendChild(head); d.appendChild(pre); d.appendChild(del);
            box.appendChild(d);
        });
    }

    function loadSettings() {
        api('/wrmanager/api/config').then(function (c) {
            buildSettingsFields(c);
            renderPending(c.pending);
        }).catch(function (e) { toast(e.message, 'err'); });
    }

    $('mult-stage').addEventListener('click', function () {
        var patch = {};
        document.querySelectorAll('[data-mult]').forEach(function (i) {
            var v = parseFloat(i.value);
            if (!isNaN(v) && v !== 1) patch[i.dataset.mult] = v;
        });
        if (!Object.keys(patch).length) return toast('Nothing changed from default.', 'err');
        if (patch.xp && patch.xp > 1 && !confirm('Raising XP to ' + patch.xp + ' cannot be undone later — lowering it is refused upstream because it can lock characters out.\n\nContinue?')) return;

        api('/wrmanager/api/config/stage', { method: 'POST', body: { target: 'multipliers', patch: patch } })
            .then(function () { toast('Staged. Apply to restart and write.'); loadSettings(); })
            .catch(function (e) { toast(e.message, 'err'); });
    });

    $('world-stage').addEventListener('click', function () {
        var patch = {};
        document.querySelectorAll('[data-world]').forEach(function (i) {
            if (i.tagName === 'SELECT') { if (i.value !== 'Normal') patch[i.dataset.world] = i.value; return; }
            var v = parseFloat(i.value);
            // Co-op ship scaling defaults to 0, everything else to 1.
            var dflt = i.dataset.world.indexOf('ShipStatsCorrection') !== -1 ? 0 : 1;
            if (!isNaN(v) && v !== dflt) patch[i.dataset.world] = v;
        });
        document.querySelectorAll('[data-worldbool]').forEach(function (i) {
            if (i.value !== 'default') patch[i.dataset.worldbool] = (i.value === 'true');
        });
        if (!Object.keys(patch).length) return toast('Nothing changed from default.', 'err');
        api('/wrmanager/api/config/stage', { method: 'POST', body: { target: 'world', patch: patch } })
            .then(function () { toast('Staged.'); loadSettings(); })
            .catch(function (e) { toast(e.message, 'err'); });
    });

    $('apply-pending').addEventListener('click', function () {
        if (!confirm('Apply staged changes?\n\nThe server will stop, the files will be written, and it will start again. Everyone is disconnected.')) return;
        var btn = $('apply-pending'); busy(btn, true, 'Applying…');
        api('/wrmanager/api/config/apply', { method: 'POST', body: {} })
            .then(function (r) {
                (r.applied || []).forEach(function (a) { (a.warnings || []).forEach(function (w) { toast(w, 'err'); }); });
                if (r.failed && r.failed.length) r.failed.forEach(function (f) { toast(f.file + ': ' + f.error, 'err'); });
                toast('Applied ' + ((r.applied || []).length) + ' change set(s).');
                loadSettings();
            })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(btn, false); });
    });

    // ------------------------------------------------------------ backups
    function loadBackups() {
        api('/wrmanager/api/backups').then(function (list) {
            var body = $('backups-body'); body.replaceChildren();
            if (!list.length) {
                var emptyRow = document.createElement('tr');
                var emptyCell = document.createElement('td');
                emptyCell.colSpan = 6; emptyCell.style.color = 'var(--text-muted)'; emptyCell.textContent = 'No snapshots yet.';
                emptyRow.appendChild(emptyCell); body.appendChild(emptyRow);
                return;
            }
            list.forEach(function (b) {
                var tr = document.createElement('tr');
                cell(tr, b.filename, 'mono');
                cell(tr, (b.sizeBytes / 1024).toFixed(1) + ' KB');
                cell(tr, new Date(b.createdAt).toLocaleString());
                cell(tr, b.createdByName || b.createdBy || (b.kind === 'scheduled' ? 'Scheduler' : '—'));
                cell(tr, b.reason || b.kind || '');
                var act = document.createElement('td');
                var btn = document.createElement('button');
                btn.className = 'btn btn-sm btn-danger'; btn.textContent = 'Restore';
                btn.addEventListener('click', function () {
                    if (prompt('Restoring REPLACES the live world.\nThe server must be stopped first.\n\nType RESTORE to confirm:') !== 'RESTORE') return;
                    busy(btn, true);
                    api('/wrmanager/api/backups/restore', { method: 'POST', body: { filename: b.filename, confirm: 'RESTORE' } })
                        .then(function (r) { toast(r.note || 'Restored. Start the server to load it.'); })
                        .catch(function (e) { toast(e.message, 'err'); })
                        .finally(function () { busy(btn, false); });
                });
                act.appendChild(btn); tr.appendChild(act);
                body.appendChild(tr);
            });
        }).catch(function (e) { toast(e.message, 'err'); });
    }

    $('backup-now').addEventListener('click', function () {
        var btn = $('backup-now'); busy(btn, true);
        api('/wrmanager/api/backups', { method: 'POST', body: {} })
            .then(function (r) { toast('Saved ' + r.filename); loadBackups(); })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(btn, false); });
    });
    $('backup-prune').addEventListener('click', function () {
        if (!confirm('Delete all but the newest 30 snapshots?')) return;
        api('/wrmanager/api/backups/prune', { method: 'POST', body: { keep: 30 } })
            .then(function (r) { toast('Removed ' + r.removed.length + '.'); loadBackups(); })
            .catch(function (e) { toast(e.message, 'err'); });
    });

    // ------------------------------------------------------------ files
    function loadFiles() {
        api('/wrmanager/api/files?path=' + encodeURIComponent(filesPath)).then(function (d) {
            text($('files-crumb'), d.path || '.');
            var body = $('files-body'); body.innerHTML = '';
            d.entries.forEach(function (e) {
                var tr = document.createElement('tr');
                var td = document.createElement('td');
                var link = document.createElement('a');
                link.href = '#';
                link.textContent = (e.type === 'dir' ? '📁 ' : '📄 ') + e.name;
                link.addEventListener('click', function (ev) {
                    ev.preventDefault();
                    var next = (filesPath === '.' ? '' : filesPath + '/') + e.name;
                    if (e.type === 'dir') { filesPath = next; loadFiles(); }
                    else { openFile(next); }
                });
                td.appendChild(link); tr.appendChild(td);
                cell(tr, e.type === 'dir' ? '' : (e.sizeBytes / 1024).toFixed(1) + ' KB');
                var act = document.createElement('td');
                if (e.type !== 'dir') {
                    var dl = document.createElement('button');
                    dl.className = 'btn btn-sm'; dl.textContent = 'Download'; dl.style.marginRight = '0.3rem';
                    dl.addEventListener('click', function () {
                        window.location = '/wrmanager/api/files/download?path=' + encodeURIComponent((filesPath === '.' ? '' : filesPath + '/') + e.name);
                    });
                    act.appendChild(dl);
                }
                var del = document.createElement('button');
                del.className = 'btn btn-sm btn-danger'; del.textContent = 'Delete';
                del.addEventListener('click', function () {
                    var target = (filesPath === '.' ? '' : filesPath + '/') + e.name;
                    if (!confirm('Delete ' + target + '?')) return;
                    api('/wrmanager/api/file', { method: 'DELETE', body: { path: target } })
                        .then(function () { toast('Deleted.'); loadFiles(); })
                        .catch(function (er) { toast(er.message, 'err'); });
                });
                act.appendChild(del); tr.appendChild(act);
                body.appendChild(tr);
            });
        }).catch(function (e) { toast(e.message, 'err'); });
    }

    function openFile(p) {
        api('/wrmanager/api/file?path=' + encodeURIComponent(p)).then(function (d) {
            $('file-editor').style.display = '';
            text($('edit-name'), p);
            $('edit-body').value = d.content;
            $('edit-save').onclick = function () {
                api('/wrmanager/api/file', { method: 'POST', body: { path: p, content: $('edit-body').value } })
                    .then(function () { toast('Saved.'); })
                    .catch(function (e) { toast(e.message, 'err'); });
            };
        }).catch(function (e) { toast(e.message, 'err'); });
    }

    $('files-up').addEventListener('click', function () {
        if (filesPath === '.' || filesPath === '') return;
        var parts = filesPath.split('/'); parts.pop();
        filesPath = parts.join('/') || '.';
        loadFiles();
    });
    $('edit-close').addEventListener('click', function () { $('file-editor').style.display = 'none'; });


    if ($('file-upload-go')) $('file-upload-go').addEventListener('click', function () {
        var f = $('file-upload-input').files[0];
        if (!f) return toast('Choose a file first.', 'err');
        var btn = $('file-upload-go'); busy(btn, true, 'Uploading…');
        var fd = new FormData(); fd.append('file', f); fd.append('dir', filesPath);
        fetch('/wrmanager/api/files/upload', {
            method: 'POST', headers: cfg.csrf ? { 'X-CSRF-Token': cfg.csrf } : {}, body: fd, credentials: 'same-origin'
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Upload failed'); return d; }); })
          .then(function () { toast('Uploaded.'); loadFiles(); })
          .catch(function (e) { toast(e.message, 'err'); })
          .finally(function () { busy(btn, false); });
    });

    if ($('files-mkdir')) $('files-mkdir').addEventListener('click', function () {
        var name = prompt('New folder name:');
        if (!name) return;
        api('/wrmanager/api/files/mkdir', { method: 'POST', body: { path: (filesPath === '.' ? '' : filesPath + '/') + name } })
            .then(function () { toast('Created.'); loadFiles(); })
            .catch(function (e) { toast(e.message, 'err'); });
    });

    function loadMods() {
        api('/wrmanager/api/mods').then(function (list) {
            var box = $('mods-list'); box.innerHTML = '';
            if (!list.length) { box.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">No mods installed.</div>'; return; }
            list.forEach(function (m) {
                var row = document.createElement('div');
                row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0.7rem;background:var(--bg-inset);border:1px solid var(--border-color);border-radius:9px;margin-bottom:0.4rem;font-size:0.85rem';
                var name = document.createElement('span');
                text(name, m.name + (m.valid ? '' : '  (no readable mod.json)'));
                var del = document.createElement('button');
                del.className = 'btn btn-sm btn-danger'; del.textContent = 'Remove';
                del.addEventListener('click', function () {
                    if (!confirm('Remove mod ' + m.name + '?')) return;
                    api('/wrmanager/api/mods', { method: 'DELETE', body: { name: m.name } })
                        .then(function () { toast('Removed.'); loadMods(); })
                        .catch(function (e) { toast(e.message, 'err'); });
                });
                row.appendChild(name); row.appendChild(del); box.appendChild(row);
            });
        }).catch(function (e) { toast(e.message, 'err'); });
    }

    $('mod-install').addEventListener('click', function () {
        api('/wrmanager/api/mods', { method: 'POST', body: { name: $('mod-name').value.trim(), initLua: $('mod-lua').value } })
            .then(function (r) { toast(r.note || 'Installed.'); loadMods(); })
            .catch(function (e) { toast(e.message, 'err'); });
    });




    // ------------------------------------------------------------ server settings
    function loadSettings2() {
        api('/wrmanager/api/settings').then(function (d) {
            var box = $('settings-fields'); box.innerHTML = '';
            Object.keys(d.schema).forEach(function (key) {
                var spec = d.schema[key], cur = d.values[key] || {};
                var wrap = document.createElement('div'); wrap.className = 'field';
                var lab = document.createElement('label');
                lab.textContent = spec.label + (spec.secret ? (cur.set ? ' (set — leave blank to keep)' : ' (not set)') : '');
                var input;
                if (key === 'USE_DIRECT_CONNECTION' || key === 'UPDATE_ON_START') {
                    input = document.createElement('select');
                    ['true', 'false'].forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v; input.appendChild(o); });
                    input.value = cur.value === 'true' ? 'true' : 'false';
                } else {
                    input = document.createElement('input');
                    if (spec.secret) { input.type = 'password'; input.placeholder = cur.set ? '••••••••' : 'not set'; }
                    else input.value = cur.value || '';
                }
                input.style.width = '100%';
                input.dataset.setting = key;
                wrap.appendChild(lab); wrap.appendChild(input);
                if (spec.note) {
                    var n = document.createElement('div'); n.className = 'hint'; n.style.marginTop = '0.3rem';
                    n.textContent = spec.note; wrap.appendChild(n);
                }
                box.appendChild(wrap);
            });
        }).catch(function (e) { toast(e.message, 'err'); });
    }

    function collectSettings() {
        var patch = {};
        document.querySelectorAll('[data-setting]').forEach(function (i) {
            // A blank password field means "keep the current one", not "clear it".
            if (i.type === 'password' && i.value === '') return;
            patch[i.dataset.setting] = i.value;
        });
        return patch;
    }

    if ($('settings-refresh')) $('settings-refresh').addEventListener('click', loadSettings2);
    if ($('settings-save')) $('settings-save').addEventListener('click', function () {
        var b = $('settings-save'); busy(b, true);
        api('/wrmanager/api/settings', { method: 'POST', body: { patch: collectSettings() } })
            .then(function (r) { toast(r.note || 'Saved.'); })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(b, false); });
    });
    if ($('settings-apply')) $('settings-apply').addEventListener('click', function () {
        if (prompt('This recreates the container and disconnects everyone.\n\nType APPLY to confirm:') !== 'APPLY') return;
        var b = $('settings-apply'); busy(b, true, 'Recreating…');
        api('/wrmanager/api/settings', { method: 'POST', body: { patch: collectSettings() } })
            .then(function () { return api('/wrmanager/api/settings/apply', { method: 'POST', body: { confirm: 'APPLY' } }); })
            .then(function (r) {
                $('settings-out').style.display = ''; text($('settings-out'), r.output || '');
                toast('Container recreated with the new settings.');
            })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(b, false); });
    });

    // ------------------------------------------------------------ players
    function renderModStatus(m) {
        var banner = $('mod-status-banner');
        if (!banner) return;
        if (m && m.available === false) {
            banner.style.display = '';
            // Be blunt: RCON answers "Kick requested" either way, so without
            // this the panel would look like it worked.
            text($('mod-status-text'), 'Kick / ban / unban are NOT functional on this build — ' + (m.reason || '')
                + ' The buttons will queue a request that nothing executes.');
            ['mod-kick', 'mod-ban', 'mod-unban'].forEach(function (id) { if ($(id)) $(id).disabled = true; });
        } else {
            banner.style.display = 'none';
            ['mod-kick', 'mod-ban', 'mod-unban'].forEach(function (id) { if ($(id)) $(id).disabled = false; });
        }
    }

    function loadPlayers(positions) {
        api('/wrmanager/api/players' + (positions ? '?positions=1' : '')).then(function (d) {
            renderModStatus(d.moderation);

            var body = $('players-body'); body.innerHTML = '';
            var list = d.players || [];
            if (!list.length) {
                body.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted)">Nobody online.</td></tr>';
            } else {
                list.forEach(function (p) {
                    var tr = document.createElement('tr');
                    cell(tr, p.name || p.player_name || 'Unknown');
                    cell(tr, p.actorId || p.steam_id || '—', 'mono');
                    cell(tr, p.position || '—', 'mono');
                    var act = document.createElement('td');
                    ['kick', 'ban'].forEach(function (a) {
                        var b = document.createElement('button');
                        b.className = 'btn btn-sm' + (a === 'ban' ? ' btn-danger' : '');
                        b.textContent = a;
                        b.style.marginRight = '0.3rem';
                        b.addEventListener('click', function () { moderate(a, p.name || p.player_name, b); });
                        act.appendChild(b);
                    });
                    tr.appendChild(act);
                    body.appendChild(tr);
                });
            }

            var bans = $('bans-list'); bans.innerHTML = '';
            if (!d.bans || !d.bans.length) {
                bans.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">No bans.</div>';
            } else {
                d.bans.forEach(function (b) {
                    var row = document.createElement('div');
                    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:0.45rem 0.7rem;background:var(--bg-inset);border:1px solid var(--border-color);border-radius:8px;margin-bottom:0.35rem;font-size:0.85rem';
                    var n = document.createElement('span'); n.className = 'mono'; text(n, b);
                    var u = document.createElement('button'); u.className = 'btn btn-sm'; u.textContent = 'Unban';
                    u.addEventListener('click', function () { moderate('unban', b, u); });
                    row.appendChild(n); row.appendChild(u); bans.appendChild(row);
                });
            }
        }).catch(function (e) { toast(e.message, 'err'); });
    }

    function moderate(action, target, btn) {
        if (!target) return toast('No player name.', 'err');
        if (action === 'ban' && !confirm('Ban ' + target + '?')) return;
        busy(btn, true);
        api('/wrmanager/api/players/moderate', { method: 'POST', body: { action: action, target: target, reason: ($('mod-reason') || {}).value || '' } })
            .then(function (r) {
                // The agent verifies execution rather than trusting RCON's reply.
                if (r.executed === false) toast(r.warning || 'Queued but not executed.', 'err');
                else toast(r.message || (action + ' sent'));
                loadPlayers();
            })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(btn, false); });
    }

    if ($('players-refresh')) $('players-refresh').addEventListener('click', function () { loadPlayers(false); });
    if ($('players-positions')) $('players-positions').addEventListener('click', function () {
        var b = $('players-positions'); busy(b, true, 'Querying…');
        api('/wrmanager/api/players?positions=1').then(function () { loadPlayers(true); })
            .catch(function (e) { toast(e.message, 'err'); }).finally(function () { busy(b, false); });
    });
    ['kick', 'ban', 'unban'].forEach(function (a) {
        var b = $('mod-' + a);
        if (b) b.addEventListener('click', function () { moderate(a, $('mod-target').value.trim(), b); });
    });

    // ------------------------------------------------------------ worlds & saves
    var pendingUpload = null;

    function loadWorlds() {
        api('/wrmanager/api/saves').then(function (d) {
            var body = $('worlds-body'); body.innerHTML = '';
            if (!d.worlds.length) { body.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted)">No worlds found.</td></tr>'; return; }
            d.worlds.forEach(function (w) {
                var tr = document.createElement('tr');
                cell(tr, w.islandId, 'mono');
                cell(tr, w.version);
                cell(tr, (w.sizeBytes / 1024).toFixed(1) + ' KB');
                cell(tr, w.active ? 'ACTIVE' : '');
                var act = document.createElement('td');
                if (!w.active) {
                    var btn = document.createElement('button');
                    btn.className = 'btn btn-sm'; btn.textContent = 'Make active';
                    btn.addEventListener('click', function () {
                        if (!confirm('Switch the active world to ' + w.islandId + '?\n\nThe server must be stopped.')) return;
                        busy(btn, true);
                        api('/wrmanager/api/saves/activate', { method: 'POST', body: { islandId: w.islandId } })
                            .then(function (r) { toast(r.note || 'Switched.'); loadWorlds(); })
                            .catch(function (e) { toast(e.message, 'err'); })
                            .finally(function () { busy(btn, false); });
                    });
                    act.appendChild(btn);
                }
                tr.appendChild(act);
                body.appendChild(tr);
            });
        }).catch(function (e) { toast(e.message, 'err'); });

        // Populate the export picker from the snapshot list.
        api('/wrmanager/api/backups').then(function (list) {
            var sel = $('export-pick'); sel.innerHTML = '';
            list.forEach(function (b) {
                var o = document.createElement('option');
                o.value = b.filename;
                o.textContent = b.filename + '  (' + (b.sizeBytes / 1024).toFixed(1) + ' KB)';
                sel.appendChild(o);
            });
        }).catch(function () {});
    }

    $('worlds-refresh').addEventListener('click', loadWorlds);

    $('save-upload').addEventListener('click', function () {
        var f = $('save-file').files[0];
        if (!f) return toast('Choose a .zip first.', 'err');

        var btn = $('save-upload'); busy(btn, true, 'Uploading…');
        var fd = new FormData();
        fd.append('save', f);

        // FormData sets its own multipart boundary — do not set Content-Type.
        fetch('/wrmanager/api/saves/upload', {
            method: 'POST',
            headers: cfg.csrf ? { 'X-CSRF-Token': cfg.csrf } : {},
            body: fd,
            credentials: 'same-origin'
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
                if (!r.ok) throw new Error(d.error || 'Upload failed');
                return d;
            });
        }).then(function (info) {
            pendingUpload = info.path;
            $('save-preview').style.display = '';
            text($('save-info'),
                'World ID : ' + (info.islandId || '(none)') + '\n' +
                'Name     : ' + (info.worldName || '(unnamed)') + '\n' +
                'Preset   : ' + (info.presetType || '?') + '\n' +
                'Size     : ' + (info.sizeBytes / 1024).toFixed(1) + ' KB\n' +
                'Entries  : ' + info.entryCount);
            toast('Validated. Review, then import.');
        }).catch(function (e) { toast(e.message, 'err'); })
          .finally(function () { busy(btn, false); });
    });

    $('save-import').addEventListener('click', function () {
        if (!pendingUpload) return;
        if (prompt('Importing switches the active world. The server must be stopped.\nThe current world is snapshotted first.\n\nType IMPORT to confirm:') !== 'IMPORT') return;
        var btn = $('save-import'); busy(btn, true, 'Importing…');
        api('/wrmanager/api/saves/import', { method: 'POST', body: { path: pendingUpload, activate: $('save-activate').checked, confirm: 'IMPORT' } })
            .then(function (r) {
                toast(r.note || 'Imported.');
                pendingUpload = null;
                $('save-preview').style.display = 'none';
                loadWorlds();
            })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(btn, false); });
    });

    $('save-cancel').addEventListener('click', function () {
        if (!pendingUpload) return;
        api('/wrmanager/api/saves/discard', { method: 'POST', body: { path: pendingUpload } })
            .then(function () { toast('Upload discarded.'); })
            .catch(function () {})
            .finally(function () { pendingUpload = null; $('save-preview').style.display = 'none'; });
    });

    $('export-go').addEventListener('click', function () {
        var name = $('export-pick').value;
        if (!name) return toast('No snapshot selected.', 'err');
        window.location = '/wrmanager/api/saves/download?filename=' + encodeURIComponent(name);
    });


    // ------------------------------------------------------------ advanced INI
    //
    // 2,461 keys across six files. Three things make that usable:
    //   - sections render collapsed and only build their rows when opened
    //     (entities alone is 1,401 keys; building them all up front locks the tab)
    //   - search covers descriptions, not just identifiers
    //   - only edited values are submitted, and the agent drops any that equal
    //     the default, so the override file stays sparse
    var iniCurrent = null;      // { name, sections }
    var iniDirty = {};          // id -> new value

    function iniValueInput(k) {
        var input;
        if (k.type === 'bool') {
            input = document.createElement('select');
            ['true', 'false'].forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v; input.appendChild(o); });
            input.value = k.value === 'true' ? 'true' : 'false';
        } else {
            input = document.createElement('input');
            input.type = (k.type === 'int' || k.type === 'float') ? 'number' : 'text';
            if (k.type === 'float') input.step = 'any';
            input.value = k.value;
        }
        input.dataset.iniId = k.id;
        input.addEventListener('input', function () {
            if (input.value === k.default) delete iniDirty[k.id];
            else iniDirty[k.id] = input.value;
            input.parentElement.parentElement.classList.toggle('ini-dirty', k.id in iniDirty);
        });
        return input;
    }

    function iniRow(k) {
        var row = document.createElement('div'); row.className = 'ini-row';
        if (k.overridden) row.classList.add('ini-dirty');

        var left = document.createElement('div');
        var name = document.createElement('div'); name.className = 'ini-name'; text(name, k.key);
        left.appendChild(name);
        if (k.description) { var d = document.createElement('div'); d.className = 'ini-desc'; text(d, k.description); left.appendChild(d); }

        var mid = document.createElement('div'); mid.appendChild(iniValueInput(k));

        var right = document.createElement('div');
        var meta = document.createElement('div'); meta.className = 'ini-over';
        text(meta, k.overridden ? 'default ' + k.default : '');
        right.appendChild(meta);
        if (k.overridden) {
            var rst = document.createElement('button');
            rst.className = 'btn btn-sm'; rst.textContent = 'reset'; rst.style.marginTop = '0.25rem';
            rst.addEventListener('click', function () {
                // Submitting the default is how an override is cleared.
                iniDirty[k.id] = k.default;
                var inp = mid.querySelector('[data-ini-id]');
                if (inp) inp.value = k.default;
                toast('Marked for reset — press Save changes.');
            });
            right.appendChild(rst);
        }

        row.appendChild(left); row.appendChild(mid); row.appendChild(right);
        return row;
    }

    function renderIniSections() {
        var box = $('ini-sections'); box.innerHTML = '';
        if (!iniCurrent) { box.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">Pick a file above.</div>'; return; }
        var onlyOver = $('ini-only-overrides').checked;

        var shown = 0;
        iniCurrent.sections.forEach(function (sec) {
            var keys = onlyOver ? sec.keys.filter(function (k) { return k.overridden; }) : sec.keys;
            if (!keys.length) return;
            shown += keys.length;

            var wrap = document.createElement('div'); wrap.className = 'ini-sec';
            var head = document.createElement('div'); head.className = 'ini-sec-head';
            var title = document.createElement('span');
            var overCount = sec.keys.filter(function (k) { return k.overridden; }).length;
            text(title, sec.name + '  (' + keys.length + (overCount ? ', ' + overCount + ' overridden' : '') + ')');
            var chev = document.createElement('span'); chev.textContent = '▸';
            head.appendChild(title); head.appendChild(chev);

            var body = document.createElement('div'); body.className = 'ini-sec-body';
            var built = false;
            head.addEventListener('click', function () {
                wrap.classList.toggle('open');
                chev.textContent = wrap.classList.contains('open') ? '▾' : '▸';
                // Build rows lazily — 1,401 inputs up front freezes the tab.
                if (!built && wrap.classList.contains('open')) {
                    keys.forEach(function (k) { body.appendChild(iniRow(k)); });
                    built = true;
                }
            });
            if (onlyOver) { wrap.classList.add('open'); chev.textContent = '▾'; keys.forEach(function (k) { body.appendChild(iniRow(k)); }); built = true; }

            wrap.appendChild(head); wrap.appendChild(body); box.appendChild(wrap);
        });

        if (!shown) box.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">No overridden values in this file.</div>';
    }

    function loadIniFile(name) {
        iniDirty = {};
        api('/wrmanager/api/ini/file?name=' + encodeURIComponent(name)).then(function (d) {
            iniCurrent = d;
            document.querySelectorAll('[data-inifile]').forEach(function (b) {
                b.classList.toggle('btn-primary', b.dataset.inifile === name);
            });
            renderIniSections();
        }).catch(function (e) { toast(e.message, 'err'); });
    }

    function loadIni() {
        api('/wrmanager/api/ini').then(function (d) {
            var box = $('ini-files'); box.innerHTML = '';
            d.files.forEach(function (f) {
                var b = document.createElement('button');
                b.className = 'btn btn-sm'; b.dataset.inifile = f.name;
                b.textContent = f.label + ' (' + f.keyCount + (f.overrideCount ? ' · ' + f.overrideCount + ' set' : '') + ')';
                b.addEventListener('click', function () { loadIniFile(f.name); });
                box.appendChild(b);
            });
        }).catch(function (e) { toast(e.message, 'err'); });
    }

    if ($('ini-only-overrides')) $('ini-only-overrides').addEventListener('change', renderIniSections);

    if ($('ini-save')) $('ini-save').addEventListener('click', function () {
        if (!iniCurrent) return toast('Pick a file first.', 'err');
        var keys = Object.keys(iniDirty);
        if (!keys.length) return toast('Nothing changed.', 'err');
        var b = $('ini-save'); busy(b, true);
        api('/wrmanager/api/ini/file', { method: 'POST', body: { name: iniCurrent.name, patch: iniDirty } })
            .then(function (r) {
                toast((r.changed.length ? r.changed.length + ' set' : '') +
                      (r.cleared.length ? (r.changed.length ? ', ' : '') + r.cleared.length + ' reset' : '') +
                      '. ' + (r.note || ''));
                loadIni(); loadIniFile(iniCurrent.name);
            })
            .catch(function (e) { toast(e.message, 'err'); })
            .finally(function () { busy(b, false); });
    });

    if ($('ini-reset')) $('ini-reset').addEventListener('click', function () {
        if (!iniCurrent) return toast('Pick a file first.', 'err');
        if (prompt('Drop EVERY override in ' + iniCurrent.label + '?\n\nType RESET to confirm:') !== 'RESET') return;
        api('/wrmanager/api/ini/reset', { method: 'POST', body: { name: iniCurrent.name, confirm: 'RESET' } })
            .then(function (r) { toast(r.note || 'Reset.'); loadIni(); loadIniFile(iniCurrent.name); })
            .catch(function (e) { toast(e.message, 'err'); });
    });

    if ($('ini-search-go')) $('ini-search-go').addEventListener('click', function () {
        var q = $('ini-search').value.trim();
        var b = $('ini-search-go'); busy(b, true);
        api('/wrmanager/api/ini/search?q=' + encodeURIComponent(q)).then(function (r) {
            var box = $('ini-search-results'); box.innerHTML = '';
            if (!r.hits.length) { box.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem">No matches.</div>'; return; }
            var head = document.createElement('div');
            head.className = 'hint'; head.style.marginTop = '0';
            head.textContent = r.count + ' match' + (r.count === 1 ? '' : 'es') + (r.truncated ? ' (truncated)' : '') + ' — click a file to open it.';
            box.appendChild(head);
            r.hits.slice(0, 60).forEach(function (h) {
                var row = document.createElement('div');
                row.style.cssText = 'display:flex;justify-content:space-between;gap:0.6rem;padding:0.4rem 0.6rem;border-bottom:1px solid var(--border-color);font-size:0.8rem';
                var l = document.createElement('div');
                var n = document.createElement('div'); n.className = 'ini-name'; text(n, h.section + ' › ' + h.key);
                var d = document.createElement('div'); d.className = 'ini-desc'; text(d, (h.description || '') + '  [' + h.fileLabel + ']');
                l.appendChild(n); l.appendChild(d);
                var v = document.createElement('div'); v.className = 'mono'; v.style.whiteSpace = 'nowrap';
                text(v, h.value + (h.overridden ? ' (set)' : ''));
                row.appendChild(l); row.appendChild(v);
                row.style.cursor = 'pointer';
                row.addEventListener('click', function () { loadIniFile(h.file); });
                box.appendChild(row);
            });
        }).catch(function (e) { toast(e.message, 'err'); })
          .finally(function () { busy(b, false); });
    });

    // ------------------------------------------------------------ audit
    function loadAudit() {
        api('/wrmanager/api/audit?limit=100').then(function (d) {
            var body = $('audit-body'); body.innerHTML = '';
            if (!d.entries.length) { body.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted)">Nothing logged yet.</td></tr>'; return; }
            d.entries.forEach(function (e) {
                var tr = document.createElement('tr');
                cell(tr, new Date(e.created_at).toLocaleString());
                cell(tr, e.discord_id || '—', 'mono');
                cell(tr, e.action);
                cell(tr, e.result);
                cell(tr, e.detail ? (typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)).slice(0, 90) : '', 'mono');
                body.appendChild(tr);
            });
        }).catch(function (e) { toast(e.message, 'err'); });
    }
    $('audit-refresh').addEventListener('click', loadAudit);

    var LOADERS = {
        ops: loadStats, 'settings-server': loadSettings2, people: loadUsers, players: function () { loadPlayers(false); }, settings: loadSettings,
        backups: loadBackups, advanced: loadIni, worlds: loadWorlds, files: function () { loadFiles(); loadMods(); }, audit: loadAudit
    };

    function boot() { loadStats(); refreshControl(); setInterval(refreshControl, 15000); }
    document.addEventListener('DOMContentLoaded', boot);
    if (document.readyState !== 'loading') boot();
})();
