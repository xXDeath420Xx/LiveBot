/* Windrose friend panel client.
 *
 * Polls the dashboard, which proxies windrose-agent, which serves from a 2s
 * cache fed by on-disk state files. Nothing here reaches RCON — status, players
 * and the log all come off disk, so polling is nearly free. Only the console
 * spends the ~1/s RCON budget, and only when someone types.
 */
(function () {
    'use strict';

    var POLL_MS = 4000;
    var cfg = window.WINDROSE || {};
    var pollTimer = null;
    var consecutiveFailures = 0;

    function $(id) { return document.getElementById(id); }

    function toast(message, kind) {
        var box = $('toast');
        if (!box) return;
        var el = document.createElement('div');
        el.className = 'toast-item ' + (kind === 'err' ? 'toast-err' : 'toast-ok');
        el.textContent = message;
        box.appendChild(el);
        setTimeout(function () { el.remove(); }, 6000);
    }

    function api(path, opts) {
        opts = opts || {};
        return fetch(path, {
            method: opts.method || 'GET',
            headers: Object.assign(
                { 'Content-Type': 'application/json' },
                // The dashboard applies CSRF protection globally; state-changing
                // calls fail without this header.
                cfg.csrf ? { 'X-CSRF-Token': cfg.csrf } : {}
            ),
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            credentials: 'same-origin'
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
                return data;
            });
        });
    }

    // ------------------------------------------------------------ rendering

    function renderStatus(s) {
        var offline = $('offline-banner');
        if (offline) offline.style.display = 'none';

        var running = s.container && s.container.running;
        var healthy = s.healthy;

        var stateEl = $('stat-state');
        if (stateEl) {
            // Three states, not two: "container up but heartbeat stale" means
            // the web layer is alive and the game is wedged, which a simple
            // online/offline badge would hide.
            var dot = 'dot-off', label = 'Offline';
            if (healthy) { dot = 'dot-on'; label = 'Online'; }
            else if (running) { dot = 'dot-warn'; label = 'Starting…'; }
            stateEl.innerHTML = '<span class="dot ' + dot + '"></span>' + label;
        }

        var server = s.server || {};
        setText('stat-players', (server.player_count != null ? server.player_count : '–') + ' / ' + (server.max_players || '–'));
        // World name comes from the save and is what players recognise; the
        // server name is a container setting and sits underneath as context.
        setText('stat-world', (s.world && s.world.name) || server.name || '–');
        setText('stat-version', server.windrose_plus ? 'v' + server.windrose_plus : '–');


        // Invite code comes from ServerDescription.json, so it is the value the
        // server actually resolved to rather than what the env asked for.
        renderConnection(s);

        renderPlayers(s.players || []);
    }

    /**
     * Render exactly ONE connection method — whichever is live.
     *
     * The modes are mutually exclusive, confirmed the hard way: a join code
     * shown as a labelled "fallback" was tried and simply did not work. Showing
     * both, in any styling, invites someone to try the dead one.
     */
    function renderConnection(s) {
        var conn = s.connection || {};
        var server = s.server || {};
        var direct = $('direct-block');
        var invite = $('invite-block');
        var hint = $('join-hint');

        // Undefined means the agent could not read ServerDescription; leave the
        // card as-is rather than guessing a method and misleading people.
        if (conn.useDirectConnection === undefined || conn.useDirectConnection === null) {
            if (hint) hint.textContent = 'Connection details unavailable right now.';
            return;
        }

        if (conn.useDirectConnection === true) {
            if (direct) direct.style.display = '';
            if (invite) invite.style.display = 'none';

            // The game asks for host and port in two separate boxes, and the
            // first is labelled "IP" even though a hostname belongs there —
            // which is exactly the sort of thing people get stuck on.
            var host = conn.host || (s.connectAddress || '').split(':')[0] || '–';
            var port = conn.port || (s.connectAddress || '').split(':')[1] || '–';
            setText('connect-host', host);
            setText('connect-port', String(port));

            if (hint) {
                hint.innerHTML = 'In Windrose: <strong>Join Server → Direct Connection</strong>. '
                    + 'The first box is labelled <strong>IP</strong> — put the address there anyway, it accepts a hostname. '
                    + 'The port goes in the second box.'
                    + passwordNote(conn);
            }
        } else {
            if (direct) direct.style.display = 'none';
            if (invite) invite.style.display = '';
            setText('invite-code', conn.inviteCode || server.invite_code || '–');
            if (hint) {
                hint.innerHTML = 'In Windrose, choose <strong>Join Server → Join Code</strong> and enter the code above.'
                    + passwordNote(conn);
            }
        }
    }

    /**
     * The panel deliberately never shows or fetches the join password.
     *
     * It is handed out in Discord instead, where /windrose join replies
     * ephemerally and only to people on the crew list. Keeping it off this page
     * means the secret never travels to a browser session at all.
     */
    function passwordNote(conn) {
        if (!conn.passwordProtected) return '';
        return ' <br><br>This server is <strong>password-protected</strong>. Ask an admin for the password, '
            + 'or run <strong>/windrose join</strong> in the Discord server — it will show you the password privately.';
    }

    function setText(id, value) {
        var el = $(id);
        if (el) el.textContent = value;
    }

    function renderPlayers(players) {
        var list = $('player-list');
        if (!list) return;
        if (!players.length) {
            list.innerHTML = '<div class="empty">Nobody’s sailing right now.</div>';
            return;
        }
        list.innerHTML = '';
        players.forEach(function (p) {
            var row = document.createElement('div');
            row.className = 'player';
            var name = document.createElement('span');
            // textContent, never innerHTML: player names are attacker-controlled.
            name.textContent = p.name || p.player_name || 'Unknown sailor';
            var meta = document.createElement('span');
            meta.style.color = 'var(--text-muted)';
            meta.style.fontSize = '0.8rem';
            meta.textContent = p.playtime || p.steam_id || '';
            row.appendChild(name);
            row.appendChild(meta);
            list.appendChild(row);
        });
    }

    function renderFeed(data) {
        var feed = $('feed');
        if (!feed) return;
        var entries = (data && (data.entries || data.history || data.lines)) || [];
        if (!entries.length) {
            feed.innerHTML = '<div style="color:var(--text-muted)">Nothing logged yet.</div>';
            return;
        }
        feed.innerHTML = '';
        entries.slice(-80).forEach(function (e) {
            var line = document.createElement('div');
            line.textContent = typeof e === 'string' ? e : (e.text || e.message || JSON.stringify(e));
            feed.appendChild(line);
        });
        feed.scrollTop = feed.scrollHeight;
    }

    function showOffline(message) {
        var banner = $('offline-banner');
        if (banner) {
            banner.style.display = '';
            banner.querySelector('span').textContent = message;
        }
        var stateEl = $('stat-state');
        if (stateEl) stateEl.innerHTML = '<span class="dot dot-off"></span>Unknown';
    }


    // ------------------------------------------------------------ sea chart
    //
    // Rendered here rather than embedding the Windrose+ page in an iframe: that
    // page lives on :8780, which is loopback-only by design and unreachable
    // from a browser. The panel proxies the same data through the agent.
    var mapBounds = null;

    function drawMap(data) {
        var canvas = $('sea-chart');
        if (!canvas || !data) return;
        var players = data.players || [];
        var creatures = data.creatures || data.mobs || [];
        var pts = players.concat(creatures).filter(function (p) {
            return typeof p.x === 'number' && typeof p.y === 'number';
        });

        var empty = $('map-empty');
        if (!pts.length) { if (empty) empty.style.display = 'flex'; return; }
        if (empty) empty.style.display = 'none';

        // Grow the viewport to fit everything seen so far, so the chart does
        // not lurch every time someone sails past the current extent.
        pts.forEach(function (p) {
            if (!mapBounds) mapBounds = { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y };
            mapBounds.minX = Math.min(mapBounds.minX, p.x); mapBounds.maxX = Math.max(mapBounds.maxX, p.x);
            mapBounds.minY = Math.min(mapBounds.minY, p.y); mapBounds.maxY = Math.max(mapBounds.maxY, p.y);
        });

        var pad = 2000;
        var minX = mapBounds.minX - pad, maxX = mapBounds.maxX + pad;
        var minY = mapBounds.minY - pad, maxY = mapBounds.maxY + pad;
        var spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
        var ctx = canvas.getContext('2d');
        var W = canvas.width, H = canvas.height;

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0a1420'; ctx.fillRect(0, 0, W, H);

        ctx.strokeStyle = 'rgba(212,160,74,0.10)'; ctx.lineWidth = 1;
        for (var i = 1; i < 8; i++) {
            var gx = (W / 8) * i, gy = (H / 8) * i;
            ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
        }

        function project(p) {
            // Keep the aspect square so the chart is not stretched.
            var scale = Math.min(W / spanX, H / spanY);
            return {
                x: (p.x - minX) * scale + (W - spanX * scale) / 2,
                y: H - ((p.y - minY) * scale + (H - spanY * scale) / 2)
            };
        }

        creatures.forEach(function (c) {
            var q = project(c);
            ctx.fillStyle = 'rgba(248,113,113,0.55)';
            ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); ctx.fill();
        });

        players.forEach(function (p) {
            var q = project(p);
            ctx.fillStyle = '#34d399';
            ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 2; ctx.stroke();
            if (p.name) {
                ctx.fillStyle = '#ede0cc';
                ctx.font = '12px Inter, sans-serif';
                ctx.fillText(String(p.name).slice(0, 24), q.x + 9, q.y + 4);
            }
        });
    }

    // ------------------------------------------------------------ polling

    function poll() {
        Promise.all([
            api('/windrose/api/status'),
            api('/windrose/api/console').catch(function () { return null; }),
            api('/windrose/api/livemap').catch(function () { return null; })
        ]).then(function (results) {
            consecutiveFailures = 0;
            renderStatus(results[0]);
            if (results[1]) renderFeed(results[1]);
            if (results[2]) drawMap(results[2]);
        }).catch(function (err) {
            consecutiveFailures++;
            // Don't shout on a single blip — a restart legitimately breaks one
            // or two polls.
            if (consecutiveFailures >= 2) showOffline(err.message || 'Live status unavailable.');
        }).finally(function () {
            // Back off while the backend is down instead of hammering it.
            var delay = consecutiveFailures > 3 ? POLL_MS * 4 : POLL_MS;
            pollTimer = setTimeout(poll, delay);
        });
    }

    // ------------------------------------------------------------ actions

    function wireCopy() {
        wireCopyButton('copy-host', 'connect-host', 'Address copied — paste it into the IP box.');
        wireCopyButton('copy-port', 'connect-port', 'Port copied.');
        wireCopyButton('copy-invite', 'invite-code', 'Join code copied.');
    }

    function wireCopyButton(btnId, srcId, okMessage) {
        var btn = $(btnId);
        if (!btn) return;
        btn.addEventListener('click', function () {
            var text = ($(srcId) || {}).textContent || '';
            var done = function () { toast(okMessage); };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text.trim()).then(done, fallback);
            } else { fallback(); }

            function fallback() {
                // http:// or an old browser — execCommand still works there.
                var ta = document.createElement('textarea');
                ta.value = text.trim();
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); done(); }
                catch (e) { toast('Copy failed — select the address manually.', 'err'); }
                ta.remove();
            }
        });
    }

    function wireLifecycle() {
        document.querySelectorAll('[data-life]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var op = btn.getAttribute('data-life');
                var warn = op === 'stop'
                    ? 'Stop the server? Anyone playing will be disconnected.'
                    : op === 'restart'
                        ? 'Restart? Players get warnings at 5 minutes and 1 minute, then the server bounces.'
                        : null;
                if (warn && !window.confirm(warn)) return;

                setBusy(btn, true);
                api('/windrose/api/lifecycle/' + op, { method: 'POST', body: {} })
                    .then(function (out) {
                        toast(out.note || (op + ' requested.'));
                    })
                    .catch(function (err) { toast(err.message, 'err'); })
                    .finally(function () { setBusy(btn, false); });
            });
        });

        var backup = $('btn-backup');
        if (backup) {
            backup.addEventListener('click', function () {
                setBusy(backup, true);
                api('/windrose/api/backup', { method: 'POST', body: {} })
                    .then(function (out) { toast('Snapshot saved: ' + (out.filename || 'ok')); })
                    .catch(function (err) { toast(err.message, 'err'); })
                    .finally(function () { setBusy(backup, false); });
            });
        }
    }

    function setBusy(btn, busy) {
        btn.disabled = busy;
        if (busy) {
            btn.dataset.label = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Working…';
        } else if (btn.dataset.label) {
            btn.innerHTML = btn.dataset.label;
        }
    }

    function wireConsole() {
        var input = $('console-input');
        var send = $('console-send');
        var out = $('console-out');
        if (!input || !send) return;

        api('/windrose/api/commands').then(function (data) {
            var list = document.getElementById('command-list');
            if (!list) return;
            (data.commands || []).forEach(function (name) {
                var opt = document.createElement('option');
                opt.value = name;
                list.appendChild(opt);
            });
        }).catch(function () { /* autocomplete is a nicety, not a requirement */ });

        function append(text, muted) {
            var line = document.createElement('div');
            line.textContent = text;
            if (muted) line.style.color = 'var(--text-muted)';
            out.appendChild(line);
            out.scrollTop = out.scrollHeight;
        }

        function run() {
            var command = input.value.trim();
            if (!command) return;

            // Optimistic echo with a pending marker. RCON round-trips through
            // the game's file spool at ~4s; without immediate feedback the
            // console reads as broken.
            append('> ' + command);
            append('  …running', true);
            var pending = out.lastChild;

            input.value = '';
            setBusy(send, true);

            api('/windrose/api/rcon', { method: 'POST', body: { command: command } })
                .then(function (res) {
                    pending.remove();
                    append(res.message || JSON.stringify(res));
                })
                .catch(function (err) {
                    pending.remove();
                    append('  ' + err.message, true);
                })
                .finally(function () { setBusy(send, false); input.focus(); });
        }

        send.addEventListener('click', run);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
    }

    // ------------------------------------------------------------ boot

    document.addEventListener('DOMContentLoaded', function () {
        wireCopy();
        if (cfg.canAdmin) { wireLifecycle(); wireConsole(); }
        poll();
    });

    // Stop polling in a hidden tab; resume on return. Ten idle tabs polling all
    // day is the easy way to make a cheap page expensive.
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) { clearTimeout(pollTimer); }
        else { clearTimeout(pollTimer); poll(); }
    });
})();
