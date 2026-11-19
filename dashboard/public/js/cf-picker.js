/*
 * cf-picker.js — searchable chip picker for every <select multiple> on the dashboard.
 *
 * Progressive enhancement: the native <select multiple> stays in the page as the source of truth
 * (forms post it, page scripts read select.selectedOptions, saves are unchanged). It is visually
 * hidden and a chip box is drawn next to it. Every change is written back to the options and
 * announced with bubbling `input` + `change` events, so dirty tracking (cf-manage.js), "Recommended
 * settings" fills (cf-settings.js) and page scripts keep working. Changes made to the select by
 * other code (option list rebuilt, values set) are picked up by a MutationObserver and a `change`
 * listener, so the chips never drift from the real value.
 *
 * Option hints read from the markup (all optional):
 *   data-kind="text|voice|category|role"   icon / prefix shown on the chip
 *   data-color="#rrggbb"                   role colour dot
 * Opt out per select with data-no-picker.
 */
(function () {
    'use strict';
    var uid = 0;
    var ENHANCED = 'cfPicker';

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function label(opt) { return String(opt.textContent || '').replace(/^#/, '').trim(); }
    function kind(opt, select) {
        if (opt.dataset.kind) return opt.dataset.kind;
        if (/^#/.test(opt.textContent || '')) return 'text';
        if (select.dataset.kind) return select.dataset.kind;
        return '';
    }
    function decorate(node, opt, select) {
        var k = kind(opt, select);
        var color = opt.dataset.color;
        if (color && color !== '#000000' && color !== '0') {
            var dot = el('span', 'cf-pk-dot');
            dot.style.background = color;
            node.appendChild(dot);
        } else if (k === 'text') {
            node.appendChild(el('span', 'cf-pk-sigil', '#'));
        } else if (k === 'voice') {
            var v = el('i', 'fas fa-volume-high cf-pk-sigil');
            v.setAttribute('aria-hidden', 'true');
            node.appendChild(v);
        } else if (k === 'category') {
            var c = el('i', 'fas fa-folder cf-pk-sigil');
            c.setAttribute('aria-hidden', 'true');
            node.appendChild(c);
        } else if (k === 'role') {
            node.appendChild(el('span', 'cf-pk-sigil', '@'));
        }
        node.appendChild(el('span', 'cf-pk-text', label(opt)));
    }
    function announce(select) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        // The unsaved-changes bar (cf-manage.js) ignores scripted events by design; a chip added or
        // removed is a real edit, so say so the way "Recommended settings" does.
        if (select.form) select.form.dispatchEvent(new CustomEvent('cf:dirty', { bubbles: true }));
    }

    function enhance(select) {
        if (select.dataset[ENHANCED] || select.hasAttribute('data-no-picker') || !select.multiple) return;
        select.dataset[ENHANCED] = '1';
        var id = 'cfpk' + (++uid);

        var box = el('div', 'cf-pk');
        // Typing in the search box is not an edit (cf-manage.js skips [data-no-savebar]).
        box.setAttribute('data-no-savebar', '');
        var chips = el('div', 'cf-pk-chips');
        var input = el('input', 'cf-pk-input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-controls', id + '-list');
        var lab = select.id && document.querySelector('label[for="' + CSS.escape(select.id) + '"]');
        var name = select.getAttribute('aria-label') || (lab && lab.textContent.trim()) || 'options';
        input.setAttribute('aria-label', 'Add to ' + name);
        var list = el('ul', 'cf-pk-list');
        list.id = id + '-list';
        list.setAttribute('role', 'listbox');
        list.hidden = true;
        chips.appendChild(input);
        box.appendChild(chips);
        box.appendChild(list);

        select.classList.add('cf-pk-native');
        select.setAttribute('tabindex', '-1');
        select.setAttribute('aria-hidden', 'true');
        select.insertAdjacentElement('afterend', box);
        // A <label for=select> now focuses the search box.
        if (lab) lab.addEventListener('click', function (e) { e.preventDefault(); input.focus(); });

        var active = -1;
        var shown = [];

        function placeholder() {
            var n = select.selectedOptions.length;
            input.placeholder = n ? 'Add more…' : (select.dataset.placeholder || 'Search and add…');
        }
        function renderChips() {
            Array.prototype.slice.call(chips.querySelectorAll('.cf-pk-chip')).forEach(function (c) { c.remove(); });
            Array.prototype.forEach.call(select.selectedOptions, function (opt) {
                var chip = el('span', 'cf-pk-chip');
                decorate(chip, opt, select);
                var x = el('button', 'cf-pk-x', '×');
                x.type = 'button';
                x.setAttribute('aria-label', 'Remove ' + label(opt));
                x.disabled = select.disabled;
                x.addEventListener('click', function (e) {
                    e.stopPropagation();
                    opt.selected = false;
                    renderChips(); announce(select);
                    if (!list.hidden) renderList();
                    input.focus();
                });
                chip.appendChild(x);
                chips.insertBefore(chip, input);
            });
            box.classList.toggle('is-disabled', !!select.disabled);
            input.disabled = !!select.disabled;
            placeholder();
        }
        function renderList() {
            var q = input.value.trim().toLowerCase().replace(/^[#@]/, '');
            list.replaceChildren();
            shown = Array.prototype.filter.call(select.options, function (o) {
                return !o.selected && !o.disabled && o.value !== '' && (!q || label(o).toLowerCase().indexOf(q) !== -1);
            }).slice(0, 200);
            if (!shown.length) {
                var none = el('li', 'cf-pk-empty', q ? 'No matches' : 'Everything is already added');
                none.setAttribute('role', 'presentation');
                list.appendChild(none);
            }
            shown.forEach(function (opt, i) {
                var li = el('li', 'cf-pk-opt');
                li.id = id + '-o' + i;
                li.setAttribute('role', 'option');
                li.setAttribute('aria-selected', i === active ? 'true' : 'false');
                if (i === active) li.classList.add('is-active');
                decorate(li, opt, select);
                li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(i); });
                list.appendChild(li);
            });
            input.setAttribute('aria-activedescendant', active >= 0 && shown[active] ? id + '-o' + active : '');
        }
        function open() {
            if (select.disabled) return;
            list.hidden = false;
            box.classList.add('is-open');
            input.setAttribute('aria-expanded', 'true');
            renderList();
        }
        function close() {
            list.hidden = true;
            box.classList.remove('is-open');
            input.setAttribute('aria-expanded', 'false');
            active = -1;
        }
        function pick(i) {
            var opt = shown[i];
            if (!opt) return;
            opt.selected = true;
            input.value = '';
            active = Math.min(i, shown.length - 2);
            renderChips(); announce(select); renderList();
        }
        function scrollActive() {
            var a = list.querySelector('.is-active');
            if (a) a.scrollIntoView({ block: 'nearest' });
        }

        box.addEventListener('click', function () { input.focus(); open(); });
        input.addEventListener('focus', open);
        input.addEventListener('blur', function () { setTimeout(close, 120); });
        input.addEventListener('input', function () { active = 0; open(); });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); active = Math.min(active + 1, shown.length - 1); renderList(); scrollActive(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); renderList(); scrollActive(); }
            else if (e.key === 'Enter') { if (!list.hidden && active >= 0) { e.preventDefault(); pick(active); } }
            else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); close(); } }
            else if (e.key === 'Backspace' && !input.value) {
                var sel = select.selectedOptions;
                if (sel.length) { sel[sel.length - 1].selected = false; renderChips(); announce(select); if (!list.hidden) renderList(); }
            }
        });

        // Other code changing the select (Recommended settings, form resets, rebuilt option lists).
        select.addEventListener('change', renderChips);
        var form = select.form;
        if (form) {
            form.addEventListener('reset', function () { setTimeout(renderChips, 0); });
            form.addEventListener('cf:dirty', function () { setTimeout(renderChips, 0); });
            form.addEventListener('cf:clean', function () { setTimeout(renderChips, 0); });
        }
        new MutationObserver(function () { renderChips(); if (!list.hidden) renderList(); })
            .observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

        renderChips();
    }

    function scan(root) {
        if (!root || !root.querySelectorAll) return;
        if (root.matches && root.matches('select[multiple]')) enhance(root);
        Array.prototype.forEach.call(root.querySelectorAll('select[multiple]'), enhance);
    }

    function start() {
        scan(document);
        new MutationObserver(function (records) {
            records.forEach(function (r) { Array.prototype.forEach.call(r.addedNodes, function (n) { if (n.nodeType === 1) scan(n); }); });
        }).observe(document.body, { childList: true, subtree: true });
    }
    window.CFPicker = { enhance: enhance, scan: scan };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
