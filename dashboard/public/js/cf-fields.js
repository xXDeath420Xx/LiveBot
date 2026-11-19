/*
 * cf-fields.js — small upgrades applied to every text field on the dashboard, no page edits needed.
 *
 * 1. Character counter: any <textarea>, or text <input> with maxlength >= 100, shows "120 / 2000"
 *    under it. It turns amber near the limit and red at the limit. For a textarea with no maxlength,
 *    data-limit="2000" opts in.
 * 2. Variable chips: if the field's own row or label documents variables like {user} or {server}
 *    (in its hint text, placeholder or data-vars="user,server"), they are shown as chips under the
 *    field. Clicking one inserts it at the cursor.
 * Opt out per field with data-no-fieldkit.
 */
(function () {
    'use strict';
    var DONE = 'cfFieldkit';
    var TOKEN = /\{([a-z][a-z0-9_.]{1,31})\}/gi;

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function rowOf(field) {
        return field.closest('.cf-row, .form-group, .mb-3, .cf-field, .gw-field, .cpr-field, label') || field.parentElement;
    }
    function variablesFor(field) {
        var found = [];
        // Variable names are case-sensitive ({memberCount}); de-duplicate without changing case.
        var add = function (t) { if (!found.some(function (f) { return f.toLowerCase() === t.toLowerCase(); })) found.push(t); };
        if (field.dataset.vars) field.dataset.vars.split(/[\s,]+/).filter(Boolean).forEach(function (v) { add(v.replace(/[{}]/g, '')); });
        var texts = [field.getAttribute('placeholder') || ''];
        var row = rowOf(field);
        if (row) {
            Array.prototype.forEach.call(row.querySelectorAll('.cf-row-desc, .form-text, .cf-hint, .text-muted, small, .hint'), function (n) { texts.push(n.textContent || ''); });
        }
        var described = field.getAttribute('aria-describedby');
        if (described) described.split(/\s+/).forEach(function (id) { var n = document.getElementById(id); if (n) texts.push(n.textContent || ''); });
        texts.forEach(function (t) { Array.from(String(t).matchAll(TOKEN)).forEach(function (m) { add(m[1]); }); });
        return found.slice(0, 16);
    }
    function insertAt(field, text) {
        var start = field.selectionStart == null ? field.value.length : field.selectionStart;
        var end = field.selectionEnd == null ? start : field.selectionEnd;
        if (typeof field.setRangeText === 'function') field.setRangeText(text, start, end, 'end');
        else field.value = field.value.slice(0, start) + text + field.value.slice(end);
        field.focus();
        // A real edit: let page scripts (previews) and the unsaved-changes bar know.
        field.dispatchEvent(new Event('input', { bubbles: true }));
        if (field.form) field.form.dispatchEvent(new CustomEvent('cf:dirty', { bubbles: true }));
    }

    function enhance(field) {
        if (field.dataset[DONE] || field.hasAttribute('data-no-fieldkit') || field.closest('.cf-pk')) return;
        if (field.tagName === 'INPUT' && !/^(text|search|)$/.test(field.type)) return;
        var limit = parseInt(field.getAttribute('maxlength') || field.dataset.limit || '0', 10);
        var isArea = field.tagName === 'TEXTAREA';
        var vars = variablesFor(field);
        var wantCounter = limit > 0 && (isArea || limit >= 100);
        if (!wantCounter && !vars.length) return;
        field.dataset[DONE] = '1';

        var bar = el('div', 'cf-fk');
        bar.setAttribute('data-no-savebar', '');
        if (vars.length) {
            var chips = el('div', 'cf-fk-vars');
            chips.setAttribute('role', 'group');
            chips.setAttribute('aria-label', 'Insert a variable');
            vars.forEach(function (v) {
                var b = el('button', 'cf-fk-var', '{' + v + '}');
                b.type = 'button';
                b.title = 'Insert {' + v + '}';
                b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the cursor where it is
                b.addEventListener('click', function () { insertAt(field, '{' + v + '}'); });
                chips.appendChild(b);
            });
            bar.appendChild(chips);
        }
        if (wantCounter) {
            var count = el('span', 'cf-fk-count');
            count.setAttribute('aria-live', 'polite');
            var paint = function () {
                var n = field.value.length;
                count.textContent = n + ' / ' + limit;
                count.classList.toggle('is-near', n >= limit * 0.9 && n < limit);
                count.classList.toggle('is-full', n >= limit);
            };
            field.addEventListener('input', paint);
            field.addEventListener('change', paint);
            if (field.form) field.form.addEventListener('reset', function () { setTimeout(paint, 0); });
            paint();
            bar.appendChild(count);
        }
        field.insertAdjacentElement('afterend', bar);
    }

    function scan(root) {
        if (!root || !root.querySelectorAll) return;
        if (root.matches && root.matches('textarea, input[maxlength]')) enhance(root);
        Array.prototype.forEach.call(root.querySelectorAll('textarea, input[maxlength]'), enhance);
    }
    function start() {
        var main = document.querySelector('.cf-main') || document.body;
        scan(main);
        new MutationObserver(function (records) {
            records.forEach(function (r) { Array.prototype.forEach.call(r.addedNodes, function (n) { if (n.nodeType === 1) scan(n); }); });
        }).observe(main, { childList: true, subtree: true });
    }
    window.CFFields = { enhance: enhance, scan: scan };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
