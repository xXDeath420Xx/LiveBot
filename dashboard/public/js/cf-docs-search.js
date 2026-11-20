/*
 * The docs search box (views/partials/docs-search-box.ejs). Without this script the box is a plain form that
 * opens /docs/search?q=. With it, the index (/docs/search.json, built by dashboard/services/docs-search.js)
 * loads on first use and matches show under the box as you type, ranked by cf-docs-search-core.js, the same
 * code the results page uses. ARIA combobox with a listbox; keys: "/" focuses the box, Up and Down move,
 * Enter opens the highlighted result or the results page, Escape closes the list and then clears the box.
 */
import { prepare, search, KIND_LABEL } from './cf-docs-search-core.js';

const SHOW = 8;
let indexPromise = null;

function loadIndex() {
    if (!indexPromise) {
        indexPromise = fetch('/docs/search.json', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then((r) => { if (!r.ok) throw new Error(`index ${r.status}`); return r.json(); })
            .then((data) => prepare((data.e || []).map(([k, t, u, s, p, x]) => ({ k, t, u, s, p, x }))))
            .catch((error) => { indexPromise = null; throw error; });
    }
    return indexPromise;
}

function setup(form) {
    const input = form.querySelector('.cf-dsearch-input');
    const pop = form.querySelector('.cf-dsearch-pop');
    const list = form.querySelector('.cf-dsearch-list');
    const status = form.querySelector('.cf-dsearch-status');
    if (!input || !pop || !list) return;
    form.classList.add('is-live');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);

    let options = [];
    let active = -1;
    let timer = null;
    let seq = 0;

    const open = (yes) => {
        pop.hidden = !yes;
        input.setAttribute('aria-expanded', yes ? 'true' : 'false');
        if (!yes) { active = -1; input.removeAttribute('aria-activedescendant'); }
    };
    const highlight = (i) => {
        options.forEach((o, k) => o.setAttribute('aria-selected', k === i ? 'true' : 'false'));
        active = i;
        if (i >= 0 && options[i]) {
            input.setAttribute('aria-activedescendant', options[i].id);
            options[i].scrollIntoView({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    };
    const option = (id, href, kind, title, sub) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'presentation');
        const a = document.createElement('a');
        a.className = 'cf-dsearch-opt';
        a.id = id;
        a.href = href;
        a.setAttribute('role', 'option');
        a.setAttribute('aria-selected', 'false');
        a.tabIndex = -1;
        if (kind) {
            const k = document.createElement('span');
            k.className = 'cf-dsearch-kind';
            k.textContent = kind;
            a.appendChild(k);
        }
        const t = document.createElement('span');
        t.className = 'cf-dsearch-t';
        t.textContent = title;
        a.appendChild(t);
        if (sub) {
            const s = document.createElement('span');
            s.className = 'cf-dsearch-s';
            s.textContent = sub;
            a.appendChild(s);
        }
        li.appendChild(a);
        return li;
    };

    async function run() {
        const q = input.value.trim();
        const mine = ++seq;
        if (!q) { list.textContent = ''; options = []; status.textContent = ''; open(false); return; }
        let prepared;
        try {
            prepared = await loadIndex();
        } catch {
            if (mine !== seq) return;
            list.textContent = '';
            options = [];
            status.textContent = 'Search could not load here. Press Enter for the results page.';
            open(true);
            return;
        }
        if (mine !== seq) return;
        const hits = search(prepared, q, { limit: 200 });
        list.textContent = '';
        hits.slice(0, SHOW).forEach((h, i) => {
            const e = h.entry;
            const sub = e.k === 'step' || (e.k === 'command' && e.p && e.p.startsWith('/')) ? `${e.p}: ${e.s || ''}` : (e.s || e.p || '');
            list.appendChild(option(`cfDocsOpt${i}`, e.u, KIND_LABEL[e.k] || '', e.t, sub));
        });
        const all = option('cfDocsOptAll', `/docs/search?q=${encodeURIComponent(q)}`, '', hits.length > SHOW ? `See all ${hits.length} results for "${q}"` : `Open the results page for "${q}"`, '');
        all.classList.add('cf-dsearch-all');
        list.appendChild(all);
        options = [...list.querySelectorAll('[role="option"]')];
        status.textContent = hits.length ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : 'Nothing matches. Try fewer or different words.';
        highlight(-1);
        open(true);
    }

    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 60); });
    input.addEventListener('focus', () => { loadIndex().catch(() => {}); if (input.value.trim() && options.length) open(true); });
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown') {
            ev.preventDefault();
            if (pop.hidden) { run(); return; }
            highlight(options.length ? (active + 1) % options.length : -1);
        } else if (ev.key === 'ArrowUp') {
            ev.preventDefault();
            if (!pop.hidden && options.length) highlight(active <= 0 ? options.length - 1 : active - 1);
        } else if (ev.key === 'Enter') {
            if (!pop.hidden && active >= 0 && options[active]) {
                ev.preventDefault();
                window.location.href = options[active].href;
            }
            // Otherwise the form submits to /docs/search.
        } else if (ev.key === 'Escape') {
            if (!pop.hidden) { ev.preventDefault(); open(false); } else if (input.value) { ev.preventDefault(); input.value = ''; run(); }
        } else if (ev.key === 'Home' || ev.key === 'End') {
            if (!pop.hidden && active >= 0 && options.length) { ev.preventDefault(); highlight(ev.key === 'Home' ? 0 : options.length - 1); }
        }
    });
    // Keep the list open while a result is being clicked; close it when focus leaves the form.
    form.addEventListener('focusout', (ev) => { if (!form.contains(ev.relatedTarget)) setTimeout(() => { if (!form.contains(document.activeElement)) open(false); }, 120); });
    list.addEventListener('mousedown', (ev) => ev.preventDefault());
    list.addEventListener('mousemove', (ev) => {
        const o = ev.target.closest('[role="option"]');
        if (o) highlight(options.indexOf(o));
    });
    document.addEventListener('click', (ev) => { if (!form.contains(ev.target)) open(false); });
}

const forms = [...document.querySelectorAll('form[data-docs-search]')];
forms.forEach(setup);
// "/" focuses the first search box, unless the reader is already typing somewhere.
document.addEventListener('keydown', (ev) => {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || !forms.length) return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    ev.preventDefault();
    const input = forms[0].querySelector('.cf-dsearch-input');
    input.focus();
    input.select();
});
