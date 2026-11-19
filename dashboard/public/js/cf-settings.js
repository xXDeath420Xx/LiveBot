/*
 * cf-settings.js — behaviour for the settings-row kit on manage feature pages (cf-settings.css,
 * dashboard/views/partials/kit/). Loaded by both manage templates; every piece is a no-op when
 * its markup is absent.
 *
 *   - "What this does" (partials/kit/_help.ejs): moved from the top of .page-content to just
 *     under the page's own title, so it reads title, then help, then settings.
 *   - "Recommended settings": fills the page's fields from #cfHelpData (core/page-help.js),
 *     marks every field it changed, lists the changes (old value, new value) with an Undo, and
 *     NEVER saves. The page's own Save buttons do that; for forms that already post, the sticky
 *     "Unsaved changes" bar (cf-manage.js) is told through a `cf:dirty` event on the form, and
 *     `cf:clean` after an Undo that left the form as it was. Fields the page builds after it
 *     loads (API-driven pages) are looked up at click time.
 *   - Modal shells (.cf-modal) are moved under <body> so position:fixed means the viewport.
 *   - Inline validation inside .cf-rows: the browser's own constraint message is shown under
 *     the field (instead of a tooltip bubble), the field gets aria-invalid, and it clears as
 *     soon as the value is valid. Submission rules are unchanged: an invalid form still does
 *     not submit.
 *
 * Values are applied with input/change events so a page's own listeners (show/hide a dependent
 * field, format a duration) react exactly as they would to a person. Those events are
 * untrusted, which is how cf-manage.js already tells them apart from real edits.
 * DOM is built with createElement/textContent throughout.
 */
(function () {
    'use strict';

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }
    function clean(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
    var content = document.querySelector('.page-content');

    /* ------------------------------------------------------------ place the help block */
    var help = document.getElementById('cfHelp');
    (function place() {
        if (!help || !content || !content.contains(help)) return;
        var head = content.querySelector('.page-section-header');
        if (!head) return;
        // Only when that header is the page's opening title: the first real element after the
        // help block is the header itself or a container that starts with it.
        var next = help.nextElementSibling;
        while (next && /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(next.tagName)) next = next.nextElementSibling;
        if (!next || !(next === head || next.contains(head))) return;
        for (var n = head; n && n !== next; n = n.parentElement) {
            var prev = n.previousElementSibling;
            while (prev && /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(prev.tagName)) prev = prev.previousElementSibling;
            if (prev && !prev.hidden) return;
        }
        head.insertAdjacentElement('afterend', help);
    })();

    /* ------------------------------------------------------------ recommended settings */
    (function () {
        var btn = document.getElementById('cfHelpRec');
        var preview = document.getElementById('cfHelpPreview');
        var dataEl = document.getElementById('cfHelpData');
        if (!btn || !preview || !dataEl || !content) return;
        var rec;
        try { rec = JSON.parse(dataEl.textContent || 'null'); } catch (e) { rec = null; }
        if (!rec || !rec.values) return;

        var undo = null;          // [{ apply: fn }] restoring the values before the last fill
        var touched = new Map();  // form -> true once a person edits it after a fill

        // Every control a key names: the element with that id, else the controls with that name.
        function controlsFor(key) {
            var byId = document.getElementById(key);
            if (byId && /^(INPUT|SELECT|TEXTAREA)$/.test(byId.tagName)) return [byId];
            var named = content.querySelectorAll('[name]');
            return Array.prototype.filter.call(named, function (n) { return n.name === key && /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName); });
        }
        function labelFor(ctl, key) {
            var text = '';
            if (ctl.id) {
                var lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(ctl.id) : ctl.id) + '"]');
                if (lab) {
                    var copy = lab.cloneNode(true);
                    Array.prototype.forEach.call(copy.querySelectorAll('small, .cf-row-desc, .form-help, .vf-muted, i'), function (x) { x.remove(); });
                    text = clean(copy.textContent);
                }
            }
            if (!text && ctl.getAttribute('aria-label')) text = clean(ctl.getAttribute('aria-label'));
            if (!text) {
                var row = ctl.closest('.cf-row');
                var rl = row && row.querySelector('.cf-row-label');
                if (rl) text = clean(rl.textContent);
            }
            if (!text) { var wrap = ctl.closest('label'); if (wrap) text = clean(wrap.textContent); }
            return (text || key).slice(0, 80);
        }
        function shown(ctl) {
            if (ctl.type === 'checkbox' || ctl.type === 'radio') return ctl.checked ? 'On' : 'Off';
            if (ctl.tagName === 'SELECT') {
                var opts = Array.prototype.filter.call(ctl.options, function (o) { return o.selected; });
                if (!opts.length) return 'None';
                if (ctl.multiple) return opts.length === 1 ? clean(opts[0].textContent) : opts.length + ' selected';
                return clean(opts[0].textContent) || 'None';
            }
            var v = String(ctl.value || '');
            return v ? (v.length > 60 ? v.slice(0, 57) + '...' : v) : 'Empty';
        }
        function optionMatching(select, names) {
            var opts = Array.prototype.slice.call(select.options).filter(function (o) { return o.value; });
            for (var i = 0; i < names.length; i++) {
                var want = String(names[i]).toLowerCase();
                var exact = opts.find(function (o) { return clean(o.textContent).toLowerCase().replace(/^[#@]/, '') === want; });
                if (exact) return exact;
                var part = opts.find(function (o) { return clean(o.textContent).toLowerCase().indexOf(want) !== -1; });
                if (part) return part;
            }
            return null;
        }
        function fire(ctl) {
            ctl.dispatchEvent(new Event('input', { bubbles: true }));
            ctl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        function snapshot(ctls) {
            var saved = ctls.map(function (c) {
                return { c: c, checked: c.checked, value: c.value, sel: c.tagName === 'SELECT' ? Array.prototype.map.call(c.options, function (o) { return o.selected; }) : null };
            });
            return function () {
                saved.forEach(function (s) {
                    if (s.sel) Array.prototype.forEach.call(s.c.options, function (o, i) { o.selected = s.sel[i]; });
                    else if (s.c.type === 'checkbox' || s.c.type === 'radio') s.c.checked = s.checked;
                    else s.c.value = s.value;
                    fire(s.c);
                });
            };
        }

        /** Apply one recommended value. Returns { label, from, to } | { label, skip } | null (no change). */
        function applyOne(key, want) {
            var ctls = controlsFor(key);
            if (!ctls.length) return { label: key, skip: 'not on this page right now' };
            var first = ctls[0];
            var label = labelFor(first, key);
            var spec = (want && typeof want === 'object' && !Array.isArray(want)) ? want : { value: want };
            var value = spec.value;
            var from;
            var restore = snapshot(ctls);

            if (first.type === 'checkbox' && ctls.length > 1 || (first.type === 'checkbox' && Array.isArray(value))) {
                // Checkbox group: turn the listed values on, leave the rest alone.
                var list = (Array.isArray(value) ? value : [value]).map(String);
                var turnOn = ctls.filter(function (c) { return list.indexOf(c.value) !== -1 && !c.checked; });
                if (!turnOn.length) return null;
                turnOn.forEach(function (c) { c.checked = true; fire(c); });
                undo.push(restore);
                var group = first.closest('[data-cf-group]');
                return { label: group ? group.getAttribute('data-cf-group') : key, from: '', to: turnOn.length + ' more switched on', ctls: turnOn };
            }
            if (first.type === 'radio') {
                var target = ctls.find(function (c) { return c.value === String(value); });
                if (!target || target.checked) return null;
                var was = ctls.find(function (c) { return c.checked; });
                target.checked = true; fire(target);
                undo.push(restore);
                return { label: label, from: was ? labelFor(was, key) : 'None', to: labelFor(target, key), ctls: [target] };
            }
            if (first.type === 'checkbox') {
                var on = !!value;
                if (first.checked === on) return null;
                from = shown(first);
                first.checked = on; fire(first);
                undo.push(restore);
                return { label: label, from: from, to: shown(first), ctls: [first] };
            }
            if (first.tagName === 'SELECT') {
                var opt = null;
                if (spec.pick) {
                    if (first.multiple) {
                        var picks = spec.pick.map(function (n) { return optionMatching(first, [n]); }).filter(Boolean);
                        picks = picks.filter(function (o, i) { return picks.indexOf(o) === i && !o.selected; });
                        if (!picks.length) return optionMatching(first, spec.pick) ? null : { label: label, skip: 'no channel or role with a matching name; choose one yourself' };
                        from = shown(first);
                        picks.forEach(function (o) { o.selected = true; });
                        fire(first);
                        undo.push(restore);
                        return { label: label, from: from, to: shown(first), ctls: [first] };
                    }
                    opt = optionMatching(first, spec.pick);
                    if (!opt) return first.value ? null : { label: label, skip: 'no channel or role with a matching name; choose one yourself' };
                    if (first.value) return null;   // already chosen: keep the admin's pick
                } else {
                    opt = Array.prototype.find.call(first.options, function (o) { return o.value === String(value); });
                    if (!opt) return { label: label, skip: 'that option is not available here' };
                }
                if (opt.selected && !first.multiple) return null;
                from = shown(first);
                if (first.multiple) opt.selected = true; else first.value = opt.value;
                fire(first);
                undo.push(restore);
                return { label: label, from: from, to: shown(first), ctls: [first] };
            }
            // text, number, textarea
            if (spec.ifEmpty && String(first.value || '').trim()) return null;
            if (String(first.value) === String(value)) return null;
            from = shown(first);
            first.value = String(value);
            fire(first);
            undo.push(restore);
            return { label: label, from: from, to: shown(first), ctls: [first] };
        }

        function markRows(ctls, on) {
            ctls.forEach(function (c) {
                var row = c.closest('.cf-row, .cf-field, .cf-list-item');
                var target = row || c;
                target.classList.toggle('cf-rec-changed', on);
            });
        }
        var marked = [];
        function clearMarks() { markRows(marked, false); marked = []; }

        function render(results) {
            var changed = results.filter(function (r) { return r && !r.skip; });
            var skipped = results.filter(function (r) { return r && r.skip; });
            preview.replaceChildren();
            var status = el('p', 'cf-help-status', changed.length
                ? (changed.length === 1 ? '1 setting filled in. ' : changed.length + ' settings filled in. ') + 'Nothing is saved until you press Save.'
                : 'Your settings already match the recommended ones.');
            preview.appendChild(status);
            if (rec.note) preview.appendChild(el('p', 'cf-help-note', rec.note));
            if (changed.length || skipped.length) {
                var ul = el('ul', 'cf-help-changes');
                changed.forEach(function (r) {
                    var li = el('li');
                    li.appendChild(el('span', 'cf-help-field', r.label));
                    var what = el('span');
                    if (r.from) { what.appendChild(el('span', 'cf-help-from', r.from)); what.appendChild(document.createTextNode(' to ')); }
                    what.appendChild(el('span', 'cf-help-to', r.to));
                    li.appendChild(what);
                    ul.appendChild(li);
                });
                skipped.forEach(function (r) {
                    var li = el('li');
                    li.appendChild(el('span', 'cf-help-field', r.label));
                    li.appendChild(el('span', 'cf-help-skip', 'Left as it is: ' + r.skip + '.'));
                    ul.appendChild(li);
                });
                preview.appendChild(ul);
            }
            var buttons = el('div', 'cf-help-buttons');
            if (changed.length) {
                var go = el('button', 'btn btn-sm btn-secondary', 'Show the first change');
                go.type = 'button';
                go.addEventListener('click', function () {
                    var c = changed[0].ctls && changed[0].ctls[0];
                    if (!c) return;
                    c.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    try { c.focus({ preventScroll: true }); } catch (e) { c.focus(); }
                });
                var back = el('button', 'btn btn-sm btn-secondary', 'Undo');
                back.type = 'button';
                back.addEventListener('click', revert);
                buttons.appendChild(go);
                buttons.appendChild(back);
            }
            var close = el('button', 'btn btn-sm btn-link', changed.length ? 'Hide this list' : 'Close');
            close.type = 'button';
            close.addEventListener('click', function () { preview.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
            buttons.appendChild(close);
            preview.appendChild(buttons);
            preview.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
        }

        function revert() {
            if (!undo) return;
            undo.slice().reverse().forEach(function (fn) { fn(); });
            undo = null;
            var forms = new Set(marked.map(function (c) { return c.form; }).filter(Boolean));
            forms.forEach(function (f) { if (!touched.get(f)) f.dispatchEvent(new CustomEvent('cf:clean', { bubbles: true })); });
            clearMarks();
            preview.replaceChildren(el('p', 'cf-help-status', 'Put back the values you had before.'));
            setTimeout(function () { if (!undo) { preview.hidden = true; btn.setAttribute('aria-expanded', 'false'); } }, 2500);
        }

        btn.addEventListener('click', function () {
            if (undo) revert();
            undo = [];
            touched = new Map();
            var results = Object.keys(rec.values).map(function (key) { return applyOne(key, rec.values[key]); });
            var changedCtls = [];
            results.forEach(function (r) { if (r && r.ctls) changedCtls = changedCtls.concat(r.ctls); });
            marked = changedCtls;
            markRows(marked, true);
            var forms = new Set(changedCtls.map(function (c) { return c.form; }).filter(Boolean));
            forms.forEach(function (f) {
                f.dispatchEvent(new CustomEvent('cf:dirty', { bubbles: true }));
                var onEdit = function (e) { if (e.isTrusted) touched.set(f, true); };
                f.addEventListener('input', onEdit);
                f.addEventListener('change', onEdit);
                f.addEventListener('submit', function () { clearMarks(); undo = null; }, { once: true });
            });
            if (!changedCtls.length) undo = null;
            render(results);
        });
    })();

    /* ------------------------------------------------------------ inline validation */
    (function () {
        if (!content) return;
        function errorFor(ctl, create) {
            var holder = ctl.closest('.cf-row-control, .cf-field');
            if (!holder) return null;
            var msg = holder.querySelector(':scope > .cf-field-error');
            if (!msg && create) {
                msg = el('p', 'cf-field-error');
                msg.id = (ctl.id || ctl.name || 'cf-field') + '-error';
                msg.setAttribute('role', 'alert');
                holder.appendChild(msg);
            }
            return msg;
        }
        function show(ctl) {
            var msg = errorFor(ctl, true);
            if (!msg) return false;
            msg.textContent = ctl.validationMessage;
            msg.hidden = false;
            ctl.setAttribute('aria-invalid', 'true');
            ctl.setAttribute('aria-errormessage', msg.id);
            return true;
        }
        function clear(ctl) {
            var msg = errorFor(ctl, false);
            if (msg) { msg.hidden = true; msg.textContent = ''; }
            ctl.removeAttribute('aria-invalid');
            ctl.removeAttribute('aria-errormessage');
        }
        var focused = false;
        content.addEventListener('invalid', function (e) {
            var ctl = e.target;
            if (!ctl.closest || !ctl.closest('.cf-rows')) return;
            if (!show(ctl)) return;
            e.preventDefault();   // our message replaces the browser's bubble; the form still does not submit
            if (!focused) {
                focused = true;
                ctl.focus();
                setTimeout(function () { focused = false; }, 0);
            }
        }, true);
        var recheck = function (e) {
            var ctl = e.target;
            if (!ctl || !ctl.closest || !ctl.closest('.cf-rows') || ctl.getAttribute('aria-invalid') !== 'true') return;
            if (ctl.checkValidity()) clear(ctl); else show(ctl);
        };
        content.addEventListener('input', recheck, true);
        content.addEventListener('change', recheck, true);
    })();

    /* ------------------------------------------------------------ modal shells */
    // A .cf-modal is fixed to the viewport, but the manage page body is animated/transformed, which
    // makes position:fixed relative to it (the dialog opened under the top bar). The shells move to
    // <body> once the page has parsed; their ids, listeners and the page's own scripts are unchanged.
    (function () {
        var shells = document.querySelectorAll('.page-content .cf-modal');
        for (var i = 0; i < shells.length; i++) document.body.appendChild(shells[i]);
    })();
})();
