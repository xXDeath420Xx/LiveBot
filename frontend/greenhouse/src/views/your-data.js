// Profile tab, website only (register H-641): the "Your data" card. "Download my data" saves the save's export
// (GET /account/export, the same content as /privacy export's game part) as a JSON file; "Delete my save" opens a
// dialog that says what goes and that it cannot be undone, asks for the word DELETE, calls POST /account/delete
// and signs out. Players who use only Twitch or Kick have no /privacy command, so this is their way in.
//
// Website only: this module is imported by web-entry.js, which only the website build uses (build.mjs). The
// Twitch panel is built from main.js alone, so neither this code nor its text is in the panel package. The card
// fills the 'profile.achievements' slot (slots.js) after phase4.js's achievements card, so views/profile.js needs
// no edit either.
import { h } from '../lib/dom.js';
import { UI } from '../copy.js';
import { IS_PANEL } from '../config.js';
import { registerSlot } from '../slots.js';
import { openDialog } from '../ui/dialog.js';
import { actionButton, section } from '../ui/widgets.js';
import { toast } from '../ui/toast.js';

/** What the server wants in { confirm } (services/cfx/http/routes/account.js DELETE_CONFIRM). */
export const CONFIRM_WORD = 'DELETE';

export const TEXT = Object.freeze({
    title: 'Your data',
    intro: 'Download a copy of what Greenhouse Tycoon keeps for this save, or delete the save. Both cover every sign-in linked to it.',
    download: 'Download my data',
    downloaded: 'Your data is downloading as a JSON file.',
    exportLimit: 'You can download your data 3 times an hour. Try again later.',
    deleteLimit: 'Too many tries. Try again in an hour.',
    remove: 'Delete my save',
    policy: 'Privacy policy: game data',
    dialogTitle: 'Delete your save?',
    whatGoes: 'This permanently deletes:',
    items: Object.freeze([
        'your greenhouse: plants, seeds, produce, cash, upgrades, staff and decorations',
        'your level, quests, achievements, stats and season results',
        'every sign-in linked to this save (Discord, Twitch or Kick) and its history'
    ]),
    kept: 'Hybrids you bred first stay in the shared list of varieties, without your name.',
    noUndo: 'This cannot be undone. You will be signed out on every device.',
    typeLabel: `Type ${CONFIRM_WORD} to confirm`,
    mismatch: `Type ${CONFIRM_WORD} in capital letters to confirm.`,
    confirm: 'Delete my save',
    deleted: 'Your save was deleted and you are signed out.'
});

export function fileName(now = new Date()) {
    return `greenhouse-tycoon-data-${now.toISOString().slice(0, 10)}.json`;
}

async function download(app) {
    let data;
    try {
        data = await app.api.get('/account/export');
    } catch (err) {
        if (err && err.code === 'RATE_LIMITED') return toast(TEXT.exportLimit, 'warn');
        return app.reportError(err);
    }
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: fileName(), class: 'sr-only', tabindex: '-1' });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast(TEXT.downloaded);
}

function openDelete(app) {
    const st = { value: '', error: null, busy: false };
    let dialog = null;

    async function submit() {
        if (st.busy) return;
        if (st.value.trim() !== CONFIRM_WORD) {
            st.error = TEXT.mismatch;
            dialog.refresh();
            const input = document.getElementById('gh-delete-confirm');
            if (input) input.focus();
            return;
        }
        st.error = null;
        st.busy = true;
        try {
            await app.api.post('/account/delete', { confirm: CONFIRM_WORD });
        } catch (err) {
            st.busy = false;
            if (err && err.code === 'RATE_LIMITED') return toast(TEXT.deleteLimit, 'warn');
            return app.reportError(err);
        }
        // The save, its sign-ins and their refresh tokens are gone: end the session here as well.
        dialog.close();
        app.session.clear(TEXT.deleted);
    }

    dialog = openDialog({
        title: TEXT.dialogTitle,
        render: (close) => h('form', { class: 'stack', novalidate: true, on: { submit: (e) => { e.preventDefault(); submit(); } } },
            h('p', { class: 'dialog-text' }, TEXT.whatGoes),
            h('ul', { class: 'delete-list small' }, TEXT.items.map(item => h('li', null, item))),
            h('p', { class: 'small muted' }, TEXT.kept),
            h('p', { class: 'strong' }, TEXT.noUndo),
            h('div', { class: 'stack-sm' },
                h('label', { for: 'gh-delete-confirm', class: 'field-label' }, TEXT.typeLabel),
                h('input', {
                    id: 'gh-delete-confirm', class: 'input', type: 'text', value: st.value, maxlength: '32', autocomplete: 'off',
                    spellcheck: 'false', autocapitalize: 'characters', 'aria-invalid': st.error ? 'true' : null,
                    'aria-describedby': st.error ? 'gh-delete-error' : null, dataset: { key: 'delete-confirm' },
                    on: { input: (e) => { st.value = e.target.value; } }
                }),
                st.error ? h('p', { id: 'gh-delete-error', class: 'field-error small', role: 'alert' }, st.error) : null),
            h('div', { class: 'row-actions' },
                h('button', { type: 'button', class: 'btn btn-secondary', dataset: { key: 'delete-cancel' }, on: { click: () => close() } }, UI.cancel),
                actionButton(TEXT.confirm, submit, { cls: 'btn-danger', key: 'delete-go' })))
    });
}

export function yourDataCard(app) {
    if (IS_PANEL || !app.state || app.state.account.review) return null;
    return h('div', { class: 'your-data stack', dataset: { card: 'your-data' } },
        section(TEXT.title, { id: 'gh-your-data' }),
        h('div', { class: 'card stack-sm', role: 'group', 'aria-labelledby': 'gh-your-data' },
            h('p', { class: 'small' }, TEXT.intro),
            h('div', { class: 'your-data-actions' },
                actionButton(TEXT.download, () => download(app), { cls: 'btn-secondary', key: 'data-download' }),
                h('button', {
                    type: 'button', class: 'btn btn-ghost btn-danger-text', 'aria-haspopup': 'dialog', dataset: { key: 'data-delete' },
                    on: { click: () => openDelete(app) }
                }, TEXT.remove)),
            h('p', { class: 'muted small' }, h('a', { href: '/privacy#greenhouse-tycoon' }, TEXT.policy))));
}

registerSlot('profile.achievements', yourDataCard);
