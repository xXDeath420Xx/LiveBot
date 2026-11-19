/*
 * cf-site.js — behaviour for the site frame (views/partials/site-header.ejs), loaded by the header
 * itself so every standalone page gets it: the phone menu, the account menu, avatar fallbacks,
 * and a small toast for action results (window.cfSite.toast(text, 'ok' | 'bad' | 'info')),
 * used instead of alert().
 */
(function () {
    'use strict';
    if (window.cfSite && window.cfSite.ready) return; // loaded twice: the first copy already wired everything

    // Phone menu
    var btn = document.getElementById('cfs-menu-btn');
    var drawer = document.getElementById('cfs-drawer');
    function setDrawer(open) {
        if (!btn || !drawer) return;
        if (open) drawer.removeAttribute('hidden'); else drawer.setAttribute('hidden', '');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (btn && drawer) {
        btn.addEventListener('click', function () { setDrawer(drawer.hasAttribute('hidden')); });
        // The drawer only exists below the desktop breakpoint; close it when the window grows.
        if (window.matchMedia) {
            var wide = window.matchMedia('(min-width: 961px)');
            var onWide = function () { if (wide.matches) setDrawer(false); };
            if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide);
        }
    }

    // Account menu (a <details>, so it opens without script): close on outside click and Escape.
    document.addEventListener('click', function (e) {
        document.querySelectorAll('.cfs-account[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
    });
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        document.querySelectorAll('.cfs-account[open]').forEach(function (d) {
            d.removeAttribute('open');
            var s = d.querySelector('summary');
            if (s) s.focus();
        });
        if (drawer && !drawer.hasAttribute('hidden')) { setDrawer(false); btn.focus(); }
    });

    // Broken avatars / icons fall back without inline onerror handlers (capture sees every <img>,
    // including ones a page script adds later).
    window.addEventListener('error', function (e) {
        var t = e.target;
        if (t && t.tagName === 'IMG' && t.hasAttribute('data-cf-fallback') && !t.__cfFb) {
            t.__cfFb = 1;
            var f = t.getAttribute('data-cf-fallback');
            if (f && t.src !== f) t.src = f;
        }
    }, true);
    document.querySelectorAll('img[data-cf-fallback]').forEach(function (img) {
        if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) img.src = img.getAttribute('data-cf-fallback');
    });

    // Toasts
    var host;
    function toast(text, tone) {
        if (!host) {
            host = document.createElement('div');
            host.className = 'cf-toasts';
            host.setAttribute('role', 'status');
            host.setAttribute('aria-live', 'polite');
            document.body.appendChild(host);
        }
        var t = document.createElement('div');
        t.className = 'cf-toast is-' + (tone || 'info');
        t.textContent = String(text || '');
        host.appendChild(t);
        setTimeout(function () { t.classList.add('is-leaving'); }, tone === 'bad' ? 7000 : 4000);
        setTimeout(function () { t.remove(); }, tone === 'bad' ? 7400 : 4400);
    }

    window.cfSite = Object.assign(window.cfSite || {}, { toast: toast, ready: true });
})();
