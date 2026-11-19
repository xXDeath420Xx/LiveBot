/*
 * cf-pagehead.js — puts a page's master on/off switch in the page header, next to the title.
 *
 * A page marks its master control with data-feature-switch (a checkbox, normally input.cf-switch).
 * The header gets a matching switch with an "On"/"Off" label that drives the real checkbox: it sets
 * it, fires the usual input/change events and cf:dirty, so the page's own Save, previews and the
 * unsaved-changes bar behave exactly as if the original were clicked. The original's row is hidden
 * (it stays in the form, so it is still submitted). Changes to the original by other code (Recommended
 * settings, a reset) are mirrored back to the header.
 */
(function () {
    'use strict';
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function headerFor(src) {
        var scope = src.closest('.page-content') || document;
        return scope.querySelector('.page-section-header') || scope.querySelector('.cf-page-title') && scope.querySelector('.cf-page-title').parentElement;
    }
    function mount(src) {
        if (src.dataset.cfHeadMounted || src.type !== 'checkbox') return;
        var head = headerFor(src);
        if (!head || head.querySelector('.cf-head-switch')) return;
        src.dataset.cfHeadMounted = '1';

        var wrap = el('label', 'cf-head-switch');
        wrap.setAttribute('data-no-savebar', '');
        var state = el('span', 'cf-head-state');
        var box = el('input', 'cf-switch');
        box.type = 'checkbox';
        box.setAttribute('role', 'switch');
        var title = (head.querySelector('.page-section-title span, .page-section-title, .cf-page-title') || {}).textContent || 'this feature';
        box.setAttribute('aria-label', 'Turn ' + title.trim() + ' on or off');
        wrap.appendChild(state);
        wrap.appendChild(box);
        head.classList.add('cf-has-head-switch');
        head.appendChild(wrap);

        var paint = function () {
            box.checked = src.checked;
            box.disabled = src.disabled;
            state.textContent = src.checked ? 'On' : 'Off';
            wrap.classList.toggle('is-on', src.checked);
        };
        box.addEventListener('change', function () {
            src.checked = box.checked;
            src.dispatchEvent(new Event('input', { bubbles: true }));
            src.dispatchEvent(new Event('change', { bubbles: true }));
            if (src.form) src.form.dispatchEvent(new CustomEvent('cf:dirty', { bubbles: true }));
            paint();
        });
        src.addEventListener('change', paint);
        if (src.form) {
            ['reset', 'cf:dirty', 'cf:clean'].forEach(function (ev) { src.form.addEventListener(ev, function () { setTimeout(paint, 0); }); });
        }
        var row = src.closest('.cf-row');
        if (row && !src.hasAttribute('data-keep-row')) row.classList.add('cf-row--in-head');
        paint();
    }
    function scan(root) {
        if (!root || !root.querySelectorAll) return;
        if (root.matches && root.matches('[data-feature-switch]')) mount(root);
        Array.prototype.forEach.call(root.querySelectorAll('[data-feature-switch]'), mount);
    }
    function start() {
        var main = document.querySelector('.cf-main') || document.body;
        scan(main);
        new MutationObserver(function (records) {
            records.forEach(function (r) { Array.prototype.forEach.call(r.addedNodes, function (n) { if (n.nodeType === 1) scan(n); }); });
        }).observe(main, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
