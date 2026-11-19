/**
 * CertiFried Extension - Season strip
 * One line above the garden: the running season, your rank, how many tournaments
 * are open, with buttons to the standings and the tournament list.
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { store } from '../state/store.js';

const REFRESH_MS = 120000;

class CFSeasonStrip extends CFBaseComponent {
    constructor() {
        super();
        this._season = null;
        this._openTournaments = 0;
        this._timer = null;
    }

    _setupSubscriptions() {
        // Only ask the server once signed in (an unsigned request would show "session expired")
        this.subscribe('auth.isAuthenticated', (signedIn) => { if (signedIn) this._load(); });
    }

    onMount() {
        this._load();
        this._timer = setInterval(() => { if (!document.hidden) this._load(); }, REFRESH_MS);
        this.on('click', '[data-go]', (e) => {
            const go = e.target.closest('[data-go]')?.dataset.go;
            if (go === 'season') store.set('ui.leaderboardType', 'season');
            document.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'more', subview: go === 'season' ? 'leaderboard' : 'tournaments' } }));
        });
    }

    onUnmount() {
        clearInterval(this._timer);
    }

    async _load() {
        if (!store.get('auth.isAuthenticated')) return;
        try {
            const [seasons, tournaments] = await Promise.all([
                api.getSeasons(5).catch(() => null),
                api.getTournaments().catch(() => null)
            ]);
            this._season = seasons?.current || null;
            this._openTournaments = (tournaments?.tournaments || []).filter(t => t.status === 'active').length;
            this.scheduleRender();
        } catch (e) { /* the strip is optional */ }
    }

    render() {
        this.className = 'cf-season-strip';
        const s = this._season;
        if (!s && !this._openTournaments) { this.setContent(); return; }
        const parts = [];
        if (s) {
            const days = Math.max(0, Math.floor((new Date(s.endsAt).getTime() - Date.now()) / 86400000));
            parts.push(h('button', { class: 'cf-season-strip__item', type: 'button', dataset: { go: 'season' } },
                h('strong', {}, s.name),
                ` · ${days} day${days === 1 ? '' : 's'} left`,
                s.me ? ` · you are #${s.me.rank}` : ''));
        }
        if (this._openTournaments) {
            parts.push(h('button', { class: 'cf-season-strip__item', type: 'button', dataset: { go: 'tournaments' } },
                `${this._openTournaments} tournament${this._openTournaments === 1 ? '' : 's'} open`));
        }
        this.setContent(...parts);
    }
}

registerComponent('cf-season-strip', CFSeasonStrip);
export default CFSeasonStrip;
