/*
 * cf-user.js — how the dashboard shows a person: avatar, display name and @username,
 * never a bare Discord id. Styles in /css/cf-user.css.
 *
 *   CFUser.cell(bits, opts)      a DOM node for one person. `bits` is the { id, username,
 *                                displayName, avatar, inServer } object the APIs return
 *                                (core/user-display.js), or just an id string / { id, name }.
 *                                Anything without a name is looked up in the background
 *                                (one batched call per page, see resolve) and the node is
 *                                filled in place; if nobody is found it shows the id in mono
 *                                with a copy button. `left: true` (someone the server confirmed
 *                                is no longer a member) adds a small "left" marker.
 *                                opts: { size: 'sm' | 'md', storedName, plain } (plain: no avatar)
 *   CFUser.resolve(ids)          Promise<{ [id]: bits }> via GET /api/guilds/:guildId/users/resolve,
 *                                cached per page, batched (100 per request). Ids the server is
 *                                still looking up on Discord (its `pending` list) are asked again
 *                                after its retryAfterMs; the id shows meanwhile.
 *   CFUser.hydrate(root)         upgrades every [data-user-id] element under root (default:
 *                                document) into a cell; data-user-name is a stored fallback name.
 *                                Runs on DOMContentLoaded and again whenever such an element is
 *                                inserted later (a MutationObserver), so innerHTML-built lists only
 *                                emit <span data-user-id="..."> placeholders.
 *   CFUser.label(bits)           "Name (@user)" / "@user" / the id, for confirm() texts.
 *
 * The guild comes from #cfNavData or the /manage/<id> path. DOM is built with
 * createElement/textContent only. Loaded with defer in the manage templates' <head>.
 */
(function () {
    'use strict';
    if (window.CFUser) return;

    var SNOWFLAKE = /^\d{15,25}$/;
    var BATCH = 100;
    var MAX_TRIES = 6;         // polls for an id the server is still looking up on Discord
    var cache = {};            // id -> bits (resolved, possibly with null names)
    var pending = {};          // id -> [callback]   (waiting for an answer, possibly across polls)
    var due = {};              // id -> true         (to be asked in the next request)
    var tries = {};            // id -> polls that came back "pending"
    var timer = null;

    function guildId() {
        try {
            var nav = document.getElementById('cfNavData');
            if (nav) { var g = JSON.parse(nav.textContent || '{}').guildId; if (g) return String(g); }
        } catch (e) { /* fall through */ }
        var m = location.pathname.match(/\/manage\/(\d{15,25})/);
        return m ? m[1] : '';
    }

    function el(tag, className, text) {
        var n = document.createElement(tag);
        if (className) n.className = className;
        if (text != null) n.textContent = text;
        return n;
    }

    function named(b) { return !!(b && (b.displayName || b.username)); }

    function label(b) {
        if (!b) return '';
        if (typeof b === 'string') b = cache[b] || { id: b };
        var name = b.displayName || b.username;
        if (!name) return String(b.id || '');
        return b.username && b.username !== name ? name + ' (@' + b.username + ')' : name;
    }

    function toast(msg, type) {
        if (typeof window.showToast === 'function') window.showToast(msg, type);
    }

    function copyButton(id) {
        var btn = el('button', 'cf-user-copy');
        btn.type = 'button';
        btn.title = 'Copy user ID';
        btn.setAttribute('aria-label', 'Copy user ID ' + id);
        var i = el('i', 'fas fa-copy');
        i.setAttribute('aria-hidden', 'true');
        btn.appendChild(i);
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var done = function () { toast('User ID copied', 'success'); };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(id).then(done, function () { toast('Could not copy: ' + id, 'error'); });
            } else {
                try {
                    var ta = el('textarea');
                    ta.value = id;
                    ta.setAttribute('readonly', '');
                    ta.style.position = 'fixed'; ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                    done();
                } catch (err) { toast('Could not copy: ' + id, 'error'); }
            }
        });
        return btn;
    }

    // Fill (or refill) a cell node from bits.
    function paint(node, b, opts) {
        opts = opts || {};
        node.textContent = '';
        node.className = 'cf-user' + (opts.size === 'sm' ? ' cf-user--sm' : '') + (b && b.inServer === false ? ' is-gone' : '');
        var id = String((b && b.id) || '');
        node.setAttribute('data-user-cell', id);
        var name = b && (b.displayName || b.username);
        if (!opts.plain) {
            if (b && b.avatar) {
                var img = el('img', 'cf-user-av');
                img.src = b.avatar;
                img.alt = '';
                img.loading = 'lazy';
                img.referrerPolicy = 'no-referrer';
                img.width = 24; img.height = 24;
                img.addEventListener('error', function () {
                    var ph = el('span', 'cf-user-av cf-user-av--blank');
                    ph.setAttribute('aria-hidden', 'true');
                    if (img.parentNode) img.parentNode.replaceChild(ph, img);
                });
                node.appendChild(img);
            } else {
                var blank = el('span', 'cf-user-av cf-user-av--blank');
                blank.setAttribute('aria-hidden', 'true');
                blank.appendChild(el('i', 'fas fa-user'));
                node.appendChild(blank);
            }
        }
        var text = el('span', 'cf-user-text');
        if (name) {
            text.appendChild(el('span', 'cf-user-name', name));
            if (b.username && b.username !== name) text.appendChild(el('span', 'cf-user-handle', '@' + b.username));
            if (b.left) text.appendChild(el('span', 'cf-user-left', 'left'));
            node.title = (b.username ? '@' + b.username + ' · ' : '') + id + (b.left ? ' · left the server' : b.inServer === false ? ' · not in the server' : '');
        } else {
            text.appendChild(el('span', 'cf-user-id', id || 'Unknown'));
            if (id) text.appendChild(copyButton(id));
            node.title = id ? 'Not found in this server (may have left). User ID ' + id : '';
        }
        node.appendChild(text);
    }

    // Ask for every id in `due`, BATCH per request. An id the server is still looking up on Discord
    // (someone who left: core/user-lookup.js) comes back in `pending`; it stays waiting and is asked
    // again after the server's retryAfterMs, at most MAX_TRIES times, then shows as the id.
    function flush() {
        timer = null;
        var ids = Object.keys(due);
        due = {};
        var gid = guildId();
        for (var i = 0; i < ids.length; i += BATCH) (function (chunk) {
            var settle = function (d) {
                var users = d && d.users;
                var later = (d && d.pending) || [];
                var again = [];
                chunk.forEach(function (id) {
                    var b = users && users[id];
                    if (!named(b) && later.indexOf(id) !== -1 && (tries[id] = (tries[id] || 0) + 1) < MAX_TRIES) {
                        again.push(id);   // still being looked up: callbacks keep waiting
                        return;
                    }
                    b = b || { id: id, username: null, displayName: null, avatar: null };
                    if (!named(b) && cache[id] && named(cache[id])) b = cache[id];
                    cache[id] = b;
                    var cbs = pending[id] || [];
                    delete pending[id];
                    cbs.forEach(function (cb) { try { cb(b); } catch (e) { /* one bad caller */ } });
                });
                if (again.length) {
                    var wait = Math.min(15000, Math.max(500, Number(d.retryAfterMs) || 2000));
                    setTimeout(function () {
                        again.forEach(function (id) { due[id] = true; });
                        if (!timer) timer = setTimeout(flush, 0);
                    }, wait);
                }
            };
            if (!gid) return settle(null);
            fetch('/api/guilds/' + gid + '/users/resolve?ids=' + chunk.join(','), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) { settle(d); })
                .catch(function () { settle(null); });
        })(ids.slice(i, i + BATCH));
    }

    function want(id, cb) {
        if (cache[id] && named(cache[id])) return cb(cache[id]);
        if (cache[id] && !pending[id]) return cb(cache[id]);   // already asked: nobody found
        var first = !pending[id];
        (pending[id] = pending[id] || []).push(cb);
        if (first) {
            due[id] = true;
            if (!timer) timer = setTimeout(flush, 25);
        }
    }

    function resolve(ids) {
        var list = [];
        (ids || []).forEach(function (id) { id = String(id || '').trim(); if (SNOWFLAKE.test(id) && list.indexOf(id) === -1) list.push(id); });
        return Promise.all(list.map(function (id) {
            return new Promise(function (res) { want(id, res); });
        })).then(function (arr) {
            var out = {};
            arr.forEach(function (b) { out[b.id] = b; });
            return out;
        });
    }

    function cell(bits, opts) {
        opts = opts || {};
        var b = typeof bits === 'string' || typeof bits === 'number' ? { id: String(bits) } : Object.assign({}, bits || {});
        b.id = String(b.id || b.userId || b.user_id || '');
        var node = el('span');
        var stored = b.name || opts.storedName || null;
        // Named already (or not an id): draw it. Nameless bits from a feature API are asked about
        // once more: the resolve endpoint can look up people who left, the feature APIs cannot.
        if (named(b) || !SNOWFLAKE.test(b.id)) {
            paint(node, b, opts);
            if (b.id && named(b) && !cache[b.id]) cache[b.id] = b;
            return node;
        }
        // Unknown yet: show the stored name (or the id) at once, then fill in whoever it is now.
        var shown = stored ? Object.assign({}, b, { username: stored, displayName: stored }) : b;
        paint(node, shown, opts);
        node.classList.add('is-loading');
        want(b.id, function (found) {
            paint(node, named(found) ? found : shown, opts);
        });
        return node;
    }

    function hydrate(root) {
        var scope = root || document;
        var nodes = scope.querySelectorAll ? scope.querySelectorAll('[data-user-id]:not([data-user-cell]):not(button):not(input):not(option):not(tr):not(form)') : [];
        Array.prototype.forEach.call(nodes, function (n) {
            if (n.hasAttribute('data-user-keep')) return;   // ids used as hooks only
            var id = n.getAttribute('data-user-id');
            if (!SNOWFLAKE.test(id || '')) return;
            var c = cell({ id: id }, { storedName: n.getAttribute('data-user-name') || null, size: n.getAttribute('data-user-size') || null, plain: n.hasAttribute('data-user-plain') });
            c.setAttribute('data-user-id', id);
            n.replaceWith(c);
        });
    }

    window.CFUser = { cell: cell, resolve: resolve, hydrate: hydrate, label: label };

    // Lists drawn later (innerHTML strings included) are upgraded as they are inserted, so a page
    // only has to emit <span data-user-id="..."> placeholders.
    function watch() {
        hydrate(document);
        if (!('MutationObserver' in window) || !document.body) return;
        var queued = false;
        new MutationObserver(function (records) {
            if (queued) return;
            for (var i = 0; i < records.length; i++) {
                var added = records[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var n = added[j];
                    if (n.nodeType === 1 && (n.hasAttribute('data-user-id') || (n.querySelector && n.querySelector('[data-user-id]')))) {
                        queued = true;
                        Promise.resolve().then(function () { queued = false; hydrate(document); });
                        return;
                    }
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
    else watch();
})();
