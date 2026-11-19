/*
 * cf-manage.js — behaviour for the server management shell (manage-tailwind.ejs).
 *
 * Everything here works from markup and two JSON blocks the template renders:
 *   #cfNavData        { guildId, page, sections: [{ key, label, items: [{ page, title, desc, icon, tags }] }] }
 *                     (core/manage-nav.js — the same list the sidebar and overview are drawn from)
 *   #cfFeatureStatus  { <page>: true|false, __live: n }  (overview only; pages absent = unknown)
 *
 * Pieces, each a no-op when its markup is absent:
 *   - sidebar drawer below 1024px, and scroll-spy for the overview's section links
 *   - overview search: "/" focuses, Esc clears, collapsed sections open while searching; it also
 *     lists matching individual settings (cf-field-search.js, core/settings-index.js)
 *   - ?field=<id> on a sub-page: scroll to that setting and highlight it (cf-field-search.js)
 *   - section collapse (remembered per browser, same storage keys as before)
 *   - status badges on page rows, from #cfFeatureStatus and the security panel's
 *     "cf:protections" event (partials/manage/_security-overview.ejs)
 *   - recently visited chips, and recording the visit on sub-pages
 *   - "Pin to overview" on sub-pages (POST /api/me/pin)
 *   - the site style picker in the overview toolbar, and "Use this style" on a
 *     ?style= preview (POST /api/me/preferences {siteStyle})
 *   - a sticky "unsaved changes" bar for forms that already submit (it presses the
 *     form's own submit button; it never changes how a form saves). The "Recommended
 *     settings" button (cf-settings.js) reports its fills with cf:dirty / cf:clean.
 *
 * DOM is built with createElement/textContent throughout.
 */
(function () {
    'use strict';

    function readJson(id) {
        var el = document.getElementById(id);
        if (!el) return null;
        try { return JSON.parse(el.textContent || 'null'); } catch (e) { return null; }
    }
    function store(key, value) {
        try {
            if (value === undefined) return localStorage.getItem(key);
            localStorage.setItem(key, value);
        } catch (e) { /* private mode: preference just isn't remembered */ }
        return null;
    }
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }
    function isTyping(target) {
        if (!target) return false;
        var tag = target.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    }

    var nav = readJson('cfNavData') || { guildId: '', page: 'overview', sections: [] };
    var byPage = {};
    (nav.sections || []).forEach(function (sec) {
        (sec.items || []).forEach(function (it) { byPage[it.page] = it; });
    });
    var main = document.getElementById('main-content');

    /* ------------------------------------------------------------ sidebar drawer */
    (function () {
        var side = document.getElementById('cfSidenav');
        var toggle = document.getElementById('cfSidenavToggle');
        var backdrop = document.getElementById('cfSidenavBackdrop');
        if (!side || !toggle) return;
        function set(open) {
            side.classList.toggle('is-open', open);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (backdrop) backdrop.hidden = !open;
            if (open) {
                var first = side.querySelector('a, summary');
                if (first) first.focus();
            }
        }
        toggle.addEventListener('click', function () { set(!side.classList.contains('is-open')); });
        if (backdrop) backdrop.addEventListener('click', function () { set(false); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && side.classList.contains('is-open')) { set(false); toggle.focus(); }
        });
        side.addEventListener('click', function (e) {
            if (e.target.closest('a[href^="#"]')) set(false);
        });
    })();

    /* ------------------------------------------------------------ overview */
    var search = document.getElementById('overviewSearch');
    var sections = Array.prototype.slice.call(document.querySelectorAll('.modules-section[data-category]'));

    // Section collapse. Same localStorage keys as the previous overview used.
    sections.forEach(function (section) {
        var key = section.getAttribute('data-category');
        var btn = section.querySelector('.section-collapse');
        var label = (section.querySelector('.section-title') || {}).textContent || '';
        function paint(collapsed) {
            section.classList.toggle('collapsed', collapsed);
            if (btn) {
                btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                btn.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + label.trim());
            }
        }
        paint(store('section-collapsed-' + key) === '1');
        if (btn) btn.addEventListener('click', function () {
            var next = !section.classList.contains('collapsed');
            paint(next);
            store('section-collapsed-' + key, next ? '1' : '0');
        });
    });

    // Search
    if (search) {
        var noResults = document.getElementById('noSearchResults');
        var countEl = document.getElementById('cfSearchCount');
        var cards = Array.prototype.slice.call(document.querySelectorAll('.module-card'));
        var index = cards.map(function (card) {
            var title = (card.querySelector('.module-title') || {}).textContent || '';
            var desc = (card.querySelector('.module-desc') || {}).textContent || '';
            var sec = card.closest('.modules-section');
            var secTitle = sec ? ((sec.querySelector('.section-title') || {}).textContent || '') : '';
            return { card: card, text: (title + ' ' + desc + ' ' + secTitle + ' ' + (card.getAttribute('data-tags') || '')).toLowerCase() };
        });

        // Individual settings inside pages, listed under the toolbar (loaded on first use).
        var fieldHits = 0;
        var fields = window.CFFields ? window.CFFields.mountResults({
            input: search,
            after: search.closest('.cf-toolbar') || search,
            guildId: nav.guildId,
            version: nav.indexVersion,
            onCount: function (n) { fieldHits = n; paintEmpty(); },
        }) : null;
        var pageHits = 0;
        var paintEmpty = function () {
            var q = (search.value || '').trim();
            if (noResults) noResults.style.display = (q && !pageHits && !fieldHits) ? 'block' : 'none';
            if (countEl) {
                var parts = [];
                if (q) parts.push(pageHits === 1 ? '1 page' : pageHits + ' pages');
                if (q && fieldHits) parts.push(fieldHits === 1 ? '1 setting' : fieldHits + ' settings');
                countEl.textContent = parts.join(', ');
            }
        };

        var apply = function () {
            var q = (search.value || '').trim().toLowerCase();
            var terms = q.split(/\s+/).filter(Boolean);
            var shown = 0;
            index.forEach(function (row) {
                var hit = terms.every(function (t) { return row.text.indexOf(t) !== -1; });
                row.card.classList.toggle('search-hidden', !hit);
                if (hit) shown++;
            });
            sections.forEach(function (section) {
                var any = !!section.querySelector('.module-card:not(.search-hidden)');
                section.classList.toggle('search-hidden', !!q && !any);
                section.classList.toggle('is-searching', !!q);
                // A collapsed section opens while it has matches, and closes again after.
                if (q && any) section.classList.remove('collapsed');
                else if (!q) section.classList.toggle('collapsed', store('section-collapsed-' + section.getAttribute('data-category')) === '1');
            });
            pageHits = shown;
            paintEmpty();
        };
        search.addEventListener('input', apply);
        search.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { search.value = ''; apply(); search.blur(); }
            if (e.key === 'Enter') {
                var first = document.querySelector('.module-card:not(.search-hidden)') || document.querySelector('#cfFieldResults:not([hidden]) .cf-field-hit');
                if (first && search.value.trim()) { e.preventDefault(); window.location.href = first.getAttribute('href'); }
            }
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
                e.preventDefault();
                search.focus();
                search.select();
            }
        });

        // Toolbar hairline once it sticks under the header
        var toolbar = search.closest('.cf-toolbar');
        if (toolbar && 'IntersectionObserver' in window) {
            var sentinel = el('div');
            sentinel.setAttribute('aria-hidden', 'true');
            toolbar.parentNode.insertBefore(sentinel, toolbar);
            new IntersectionObserver(function (entries) {
                toolbar.classList.toggle('is-stuck', !entries[0].isIntersecting);
            }, { rootMargin: '-57px 0px 0px 0px' }).observe(sentinel);
        }
    }

    // Scroll-spy for the overview's section links
    (function () {
        var links = Array.prototype.slice.call(document.querySelectorAll('.cf-sidenav-link[data-spy]'));
        if (!links.length || !('IntersectionObserver' in window)) return;
        var visible = {};
        var mark = function () {
            var current = null;
            sections.forEach(function (s) { if (!current && visible[s.getAttribute('data-category')]) current = s.getAttribute('data-category'); });
            links.forEach(function (a) { a.classList.toggle('is-active', a.getAttribute('data-spy') === current); });
        };
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) { visible[en.target.getAttribute('data-category')] = en.isIntersecting; });
            mark();
        }, { rootMargin: '-120px 0px -55% 0px' });
        sections.forEach(function (s) { io.observe(s); });
    })();

    /* ------------------------------------------------------------ ?field= jump */
    if (window.CFFields && nav.page && nav.page !== 'overview') window.CFFields.highlightFromUrl();

    /* ------------------------------------------------------------ status badges */
    var statusFor = function (page) { return document.querySelectorAll('[data-status-for="' + page + '"]'); };
    var setStatus = function (page, state, text) {
        Array.prototype.forEach.call(statusFor(page), function (badge) {
            badge.hidden = false;
            badge.className = 'cf-status ' + (state === 'on' ? 'is-on' : state === 'live' ? 'is-live' : state === 'off' ? 'is-off' : '');
            badge.textContent = text;
        });
    };
    var featureStatus = readJson('cfFeatureStatus');
    if (featureStatus) {
        Object.keys(featureStatus).forEach(function (page) {
            if (page.indexOf('__') === 0) return;
            // 'on' | 'off' (set up, switched off) | 'none' (manage-tailwind.ejs pageState); true/false from older renders.
            var st = featureStatus[page];
            var s = (st === true || st === 'on') ? 'on' : st === 'off' ? 'off' : 'none';
            setStatus(page, s, s === 'on' ? 'On' : s === 'off' ? 'Off' : 'Not set up');
        });
        if (featureStatus.__live > 0) setStatus('streamers', 'live', featureStatus.__live + ' live');
    }
    // Protection state from the security panel is authoritative for the pages it covers, so it
    // is applied after (over) featureStatus. The panel may finish loading before or after this
    // script runs: take what it already published, and listen for the rest.
    var applyProtections = function (list) {
        (list || []).forEach(function (p) {
            if (!p || !p.page || p.on === null || p.on === undefined) return;
            setStatus(p.page, p.on ? 'on' : 'off', p.on ? 'On' : 'Off');
        });
        refreshCounts();
    };
    document.addEventListener('cf:protections', function (e) { applyProtections(e.detail); });
    if (window.__cfProtections) applyProtections(window.__cfProtections);
    function refreshCounts() {
        sections.forEach(function (section) {
            var count = section.querySelector('.section-count');
            if (!count) return;
            var total = section.querySelectorAll('.module-card').length;
            var on = section.querySelectorAll('.cf-status.is-on, .cf-status.is-live').length;
            count.textContent = total + (total === 1 ? ' page' : ' pages') + (on ? ' · ' + on + ' on' : '');
        });
    }
    refreshCounts();

    /* ------------------------------------------------------------ recently visited */
    (function () {
        var STORAGE_KEY = 'recent-visited-' + nav.guildId;
        var MAX_RECENT = 8;
        var recent = [];
        try { recent = JSON.parse(store(STORAGE_KEY) || '[]') || []; } catch (e) { recent = []; }

        var container = document.getElementById('recentVisited');
        var grid = document.getElementById('recentVisitedGrid');
        if (container && grid) {
            var known = recent.filter(function (p) { return byPage[p]; });
            if (known.length) {
                container.style.display = '';
                grid.textContent = '';
                known.forEach(function (page) {
                    var it = byPage[page];
                    var a = el('a', 'recent-chip');
                    a.href = '/manage/' + nav.guildId + '?page=' + encodeURIComponent(page);
                    var icon = el('i', it.icon);
                    icon.setAttribute('aria-hidden', 'true');
                    a.appendChild(icon);
                    a.appendChild(el('span', null, it.title));
                    grid.appendChild(a);
                });
            }
        }

        var current = nav.page;
        if (current && current !== 'overview') {
            recent = [current].concat(recent.filter(function (p) { return p !== current; })).slice(0, MAX_RECENT);
            store(STORAGE_KEY, JSON.stringify(recent));
        }
    })();

    /* ------------------------------------------------------------ pin */
    (function () {
        var btn = document.getElementById('cfPinBtn');
        if (!btn) return;
        var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
        btn.addEventListener('click', async function () {
            btn.disabled = true;
            try {
                var res = await fetch('/api/me/pin', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-CSRF-Token': csrf },
                    body: JSON.stringify({ page: btn.getAttribute('data-page') }),
                });
                var data = await res.json().catch(function () { return {}; });
                if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
                var pinned = (data.pinnedPages || []).indexOf(btn.getAttribute('data-page')) !== -1;
                btn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
                var label = btn.querySelector('span');
                if (label) label.textContent = pinned ? 'Pinned' : 'Pin to overview';
                if (window.showToast) window.showToast(pinned ? 'Pinned to the overview' : 'Removed from pinned', 'success');
            } catch (err) {
                if (window.showToast) window.showToast('Could not update pins: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
            }
        });
    })();

    /* ------------------------------------------------------------ site style */
    // The toolbar's style picker and the "Use this style" button on a ?style= preview.
    // The style is applied to <html data-style> at once and saved to the account
    // (POST /api/me/preferences {siteStyle}); a failed save puts the old style back.
    // The guild is remembered so Settings can preview styles on this overview.
    (function () {
        if (nav.guildId) store('cf-last-guild', nav.guildId);
        var root = document.documentElement;
        var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
        function saveStyle(style) {
            return fetch('/api/me/preferences', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-CSRF-Token': csrf },
                // The grid too: a Rows / Compact list layout makes every style look alike.
                body: JSON.stringify({ siteStyle: style, dashboardLayout: 'grid' }),
            }).then(function (res) {
                if (res.ok) return;
                return res.json().catch(function () { return {}; }).then(function (data) {
                    throw new Error(data.error || ('Request failed (' + res.status + ')'));
                });
            });
        }
        var select = document.getElementById('cfStyleSelect');
        if (select) {
            select.addEventListener('change', function () {
                var previous = root.getAttribute('data-style') || 'cards';
                var next = select.value;
                root.setAttribute('data-style', next);
                var main = document.getElementById('main-content');
                if (main) main.setAttribute('data-layout', 'grid');
                document.querySelectorAll('[data-layout-set]').forEach(function (b) {
                    var on = b.getAttribute('data-layout-set') === 'grid';
                    b.classList.toggle('active', on);
                    b.setAttribute('aria-pressed', on ? 'true' : 'false');
                });
                saveStyle(next).then(function () {
                    if (window.showToast) window.showToast('Style saved', 'success');
                }).catch(function (err) {
                    root.setAttribute('data-style', previous);
                    select.value = previous;
                    if (window.showToast) window.showToast('Could not save the style: ' + err.message, 'error');
                });
            });
        }
        var use = document.getElementById('cfPreviewUse');
        if (use) {
            use.addEventListener('click', function () {
                use.disabled = true;
                saveStyle(use.getAttribute('data-style')).then(function () {
                    var url = new URL(window.location.href);
                    url.searchParams.delete('style');
                    window.location.replace(url.toString());
                }).catch(function (err) {
                    use.disabled = false;
                    if (window.showToast) window.showToast('Could not save the style: ' + err.message, 'error');
                });
            });
        }
    })();

    /* ------------------------------------------------------------ unsaved changes bar */
    (function () {
        var content = document.querySelector('.cf-manage .page-content');
        if (!content) return;
        var forms = Array.prototype.slice.call(content.querySelectorAll('form')).filter(function (f) {
            if ((f.getAttribute('method') || '').toLowerCase() !== 'post') return false;
            if (f.closest('.modal') || f.hasAttribute('data-no-savebar')) return false;
            return !!f.querySelector('button[type="submit"], input[type="submit"]');
        });
        if (!forms.length) return;

        var bar = el('div', 'cf-savebar');
        bar.hidden = true;
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', 'Unsaved changes');
        var text = el('div', 'cf-savebar-text');
        var strong = el('strong', null, 'Unsaved changes');
        text.appendChild(strong);
        var where = el('span');
        text.appendChild(where);
        var save = el('button', 'btn btn-primary btn-sm', 'Save changes');
        save.type = 'button';
        bar.appendChild(text);
        bar.appendChild(save);
        content.appendChild(bar);

        var dirty = new Set();
        var formLabel = function (f) {
            var head = f.closest('section, .card, .manage-card, .page-section, [class*="section"]');
            var h = head ? head.querySelector('h2, h3, h4, .card-title, .page-section-title') : null;
            return h ? h.textContent.trim().replace(/\s+/g, ' ') : '';
        };
        var paint = function () {
            var list = Array.from(dirty);
            bar.hidden = list.length === 0;
            if (!list.length) return;
            if (list.length === 1) {
                var label = formLabel(list[0]);
                where.textContent = label ? ' in ' + label : '';
                save.hidden = false;
            } else {
                // More than one form changed: each still has its own Save button.
                where.textContent = ' in ' + list.length + ' sections. Save each section with its own button.';
                save.hidden = true;
            }
        };
        forms.forEach(function (f) {
            var mark = function (e) {
                if (!e.isTrusted) return;                      // scripted value changes are not edits
                if (e.target && e.target.closest('[data-no-savebar]')) return;
                dirty.add(f);
                paint();
            };
            f.addEventListener('input', mark);
            f.addEventListener('change', mark);
            // "Recommended settings" (cf-settings.js) fills fields with scripted events, which `mark`
            // ignores; it says so with cf:dirty, and cf:clean after an Undo nobody edited past.
            f.addEventListener('cf:dirty', function () { dirty.add(f); paint(); });
            f.addEventListener('cf:clean', function () { dirty.delete(f); paint(); });
            f.addEventListener('submit', function () { dirty.delete(f); paint(); });
            f.addEventListener('reset', function () { dirty.delete(f); paint(); });
        });
        save.addEventListener('click', function () {
            var f = Array.from(dirty)[0];
            if (!f) return;
            var submitter = f.querySelector('button[type="submit"], input[type="submit"]');
            if (typeof f.requestSubmit === 'function') f.requestSubmit(submitter || undefined);
            else if (submitter) submitter.click();
        });
    })();
})();
