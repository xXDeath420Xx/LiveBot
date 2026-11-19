/*
 * cf-field-search.js — search the individual settings inside manage pages, and jump to one.
 *
 *   CFFields.load(version)            fetches GET /api/settings-index?v=<version> once
 *                                     ({ pages: { page: [[label, field]] }, titles: { page: title } },
 *                                     core/settings-index.js) and resolves to a flat entry list
 *   CFFields.entries()                the loaded list, or null before it arrives
 *   CFFields.match(entries, q, limit) entries whose label + page title contain every word of q,
 *                                     best first (label starts with the query, then whole-word hits)
 *   CFFields.href(guildId, entry)     /manage/<id>?page=<page>&field=<field>
 *   CFFields.mountResults(opts)       a "Settings" result list under the overview search box
 *   CFFields.highlightFromUrl()       on a page opened with ?field=: find that field (waiting for
 *                                     fields a page draws after loading), open its tab or <details>,
 *                                     scroll it into view, highlight it and focus its control
 *
 * Used by both manage templates (Cards/Compact and Classic) and by their Ctrl+K finders. DOM is
 * built with createElement/textContent. match() is pure and unit-tested (tests/nav-polish.test.js
 * loads this file in a sandbox).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.CFFields = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var loaded = null;
    var loading = null;

    function flatten(data) {
        var out = [];
        var pages = (data && data.pages) || {};
        var titles = (data && data.titles) || {};
        Object.keys(pages).forEach(function (page) {
            (pages[page] || []).forEach(function (row) {
                var label = String(row[0] || '');
                var title = String(titles[page] || page);
                out.push({ page: page, pageTitle: title, label: label, field: String(row[1] || ''), text: (label + ' ' + title).toLowerCase() });
            });
        });
        return out;
    }

    function load(version) {
        if (loaded) return Promise.resolve(loaded);
        if (!loading) {
            loading = fetch('/api/settings-index?v=' + encodeURIComponent(version || 0), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
                .then(function (res) {
                    if (!res.ok) throw new Error('Request failed (' + res.status + ')');
                    return res.json();
                })
                .then(function (data) { loaded = flatten(data); return loaded; })
                .catch(function (err) { loading = null; throw err; });
        }
        return loading;
    }

    function match(entries, query, limit) {
        var q = String(query || '').trim().toLowerCase();
        if (q.length < 2) return [];
        var terms = q.split(/\s+/).filter(Boolean);
        var scored = [];
        (entries || []).forEach(function (e) {
            for (var i = 0; i < terms.length; i++) if (e.text.indexOf(terms[i]) === -1) return;
            var label = e.label.toLowerCase();
            var score = 0;
            if (label === q) score += 100;
            if (label.indexOf(q) === 0) score += 50;
            if (label.indexOf(q) !== -1) score += 25;
            terms.forEach(function (t) {
                if (label.indexOf(t) !== -1) score += 6;
                if (new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(label)) score += 4;
            });
            if (e.field.indexOf('text:') === 0) score -= 3;    // a section heading ranks under a real field
            score -= Math.min(10, label.length / 12);           // shorter, more specific labels first
            scored.push({ e: e, s: score });
        });
        scored.sort(function (a, b) { return b.s - a.s || a.e.label.localeCompare(b.e.label); });
        return scored.slice(0, limit || 10).map(function (x) { return x.e; });
    }

    function href(guildId, e) {
        return '/manage/' + encodeURIComponent(guildId) + '?page=' + encodeURIComponent(e.page) + '&field=' + encodeURIComponent(e.field);
    }

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    /**
     * Results list under the overview search box.
     * opts: { input, after (element the list goes after), guildId, version, onCount(n) }
     */
    function mountResults(opts) {
        var input = opts.input;
        if (!input) return null;
        var box = el('div', 'cf-field-results');
        box.id = 'cfFieldResults';
        box.hidden = true;
        box.setAttribute('aria-live', 'polite');
        var head = el('div', 'cf-field-results-head', 'Settings');
        var list = el('ul', 'cf-field-results-list');
        box.appendChild(head);
        box.appendChild(list);
        (opts.after || input).insertAdjacentElement('afterend', box);
        var last = '';
        function paint() {
            var q = (input.value || '').trim();
            last = q;
            if (q.length < 2) { box.hidden = true; if (opts.onCount) opts.onCount(0); return; }
            load(opts.version).then(function (entries) {
                if ((input.value || '').trim() !== last) return;     // a newer keystroke won
                var hits = match(entries, q, 12);
                list.textContent = '';
                hits.forEach(function (e) {
                    var li = el('li');
                    var a = el('a', 'cf-field-hit');
                    a.href = href(opts.guildId, e);
                    var ic = el('i', 'fas fa-sliders');
                    ic.setAttribute('aria-hidden', 'true');
                    a.appendChild(ic);
                    var txt = el('span', 'cf-field-hit-text');
                    txt.appendChild(el('span', 'cf-field-hit-label', e.label));
                    txt.appendChild(el('span', 'cf-field-hit-page', e.pageTitle));
                    a.appendChild(txt);
                    li.appendChild(a);
                    list.appendChild(li);
                });
                head.textContent = hits.length === 1 ? '1 setting' : hits.length + ' settings';
                box.hidden = !hits.length;
                if (opts.onCount) opts.onCount(hits.length);
            }).catch(function () { box.hidden = true; if (opts.onCount) opts.onCount(0); });
        }
        input.addEventListener('input', paint);
        input.addEventListener('focus', function () { load(opts.version).catch(function () {}); }, { once: true });
        return { paint: paint, box: box };
    }

    function visible(node) {
        if (!node || !node.getClientRects().length) return false;
        var s = getComputedStyle(node);
        return s.visibility !== 'hidden' && s.display !== 'none';
    }

    /** Bring a node that sits in a closed <details>, Bootstrap tab pane or hidden tab panel into view. */
    function reveal(node) {
        for (var p = node.parentElement; p; p = p.parentElement) {
            if (p.tagName === 'DETAILS' && !p.open) p.open = true;
            if (p.id && !visible(p)) {
                var sel = '[data-bs-target="#' + p.id + '"], [href="#' + p.id + '"], [aria-controls="' + p.id + '"], [data-tab="' + p.id + '"], [data-target="#' + p.id + '"]';
                var trigger = document.querySelector(sel);
                if (trigger) trigger.click();
            }
        }
    }

    function findTarget(field) {
        if (field.indexOf('text:') === 0) {
            var want = field.slice(5).trim().toLowerCase();
            var nodes = document.querySelectorAll('.page-content h2, .page-content h3, .page-content h4');
            for (var i = 0; i < nodes.length; i++) {
                if ((nodes[i].textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === want) return nodes[i];
            }
            return null;
        }
        return document.getElementById(field);
    }

    function highlightFromUrl() {
        var params = new URLSearchParams(window.location.search);
        var field = params.get('field');
        if (!field || field.length > 200) return;
        var tries = 0;
        (function attempt() {
            var target = findTarget(field);
            if (!target) {
                if (++tries < 40) return setTimeout(attempt, 150);    // fields drawn after the page's own fetch
                return;
            }
            reveal(target);
            var labelFor = target.id ? document.querySelector('label[for="' + target.id + '"]') : null;
            var box = target.closest('.fc-field, .form-group, .mb-3, .setting-row, .vf-field, .mod-form-group, .welcome-form-group, .form-check, .cf-row') ||
                (labelFor && labelFor.parentElement) || target.parentElement || target;
            setTimeout(function () {
                box.scrollIntoView({ behavior: 'smooth', block: 'center' });
                box.classList.add('cf-field-flash');
                setTimeout(function () { box.classList.remove('cf-field-flash'); }, 2600);
                if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target.tagName)) {
                    try { target.focus({ preventScroll: true }); } catch (e) { /* old browsers */ }
                }
            }, 60);
            // Keep the URL clean so a reload does not flash it again.
            params.delete('field');
            var q = params.toString();
            history.replaceState(history.state, '', window.location.pathname + (q ? '?' + q : '') + window.location.hash);
        })();
    }

    return { load: load, entries: function () { return loaded; }, match: match, href: href, mountResults: mountResults, highlightFromUrl: highlightFromUrl, _flatten: flatten };
});
