/**
 * Mutations Component
 * View discovered mutations and active plant mutations
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';

const RARITY_COLORS = {
    common: '#9ca3af',
    uncommon: '#22c55e',
    rare: '#3b82f6',
    epic: '#8b5cf6',
    legendary: '#f59e0b'
};

const EFFECT_LABELS = {
    yield_bonus: 'Yield',
    quality_bonus: 'Quality',
    grow_speed: 'Grow Speed',
    thc_boost: 'THC',
    cbd_boost: 'CBD',
    value_bonus: 'Sale Value'
};

class CFMutations extends CFBaseComponent {
    constructor() {
        super();
        this._collection = [];
        this._activeMutations = [];
        this._stats = { total: 0, discovered: 0, completion: 0 };
        this._loading = true;
        this._error = null;
        this._activeTab = 'collection';
    }

    async onMount() {
        await this._loadMutations();

        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });
    }

    async _loadMutations() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._collection.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getMutations();
            if (response.success) {
                this._collection = response.collection || [];
                this._activeMutations = response.activeMutations || [];
                this._stats = response.stats || { total: 0, discovered: 0, completion: 0 };
            } else {
                this._error = response.error;
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    render() {
        this.className = 'cf-mutations';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadMutations() }, 'Retry')
                )
            );
            return;
        }

        const content = [];

        // Header with stats
        content.push(
            h('div', { style: { marginBottom: 'var(--space-4)' } },
                h('h2', { class: 'cf-section__title' }, 'Mutations'),
                h('p', { class: 'text-sm text-muted' },
                    `Discovered ${this._stats.discovered}/${this._stats.total} (${this._stats.completion}%)`
                )
            )
        );

        // Progress bar
        content.push(
            h('div', { class: 'cf-progress mb-4' },
                h('div', {
                    class: 'cf-progress__bar',
                    style: { width: `${this._stats.completion}%`, background: 'var(--color-success)' }
                })
            )
        );

        // Tabs
        content.push(
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'collection' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'collection' }
                }, 'Collection'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'active' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'active' }
                }, `Active (${this._activeMutations.length})`)
            )
        );

        // Content
        if (this._activeTab === 'collection') {
            content.push(this._renderCollection());
        } else {
            content.push(this._renderActiveMutations());
        }

        this.setContent(...content);
    }

    _renderCollection() {
        // Group by rarity
        const byRarity = {
            legendary: [],
            epic: [],
            rare: [],
            uncommon: [],
            common: []
        };

        for (const mutation of this._collection) {
            if (byRarity[mutation.rarity]) {
                byRarity[mutation.rarity].push(mutation);
            }
        }

        const sections = [];

        for (const [rarity, mutations] of Object.entries(byRarity)) {
            if (mutations.length === 0) continue;

            sections.push(
                h('div', { class: 'cf-mutation-section mb-3' },
                    h('h4', {
                        class: 'text-xs font-semibold mb-2',
                        style: { color: RARITY_COLORS[rarity], textTransform: 'uppercase' }
                    }, `${rarity} (${mutations.filter(m => m.isDiscovered).length}/${mutations.length})`),
                    h('div', { class: 'cf-mutation-grid' },
                        ...mutations.map(m => this._renderMutationCard(m))
                    )
                )
            );
        }

        return h('div', { class: 'cf-collection' }, ...sections);
    }

    _renderMutationCard(mutation) {
        const color = RARITY_COLORS[mutation.rarity] || '#666';
        const effectLabel = EFFECT_LABELS[mutation.effectType] || mutation.effectType;
        const effectValue = mutation.effectType.includes('bonus')
            ? `${mutation.effectValue > 0 ? '+' : ''}${Math.round(mutation.effectValue * 100)}%`
            : `${mutation.effectValue > 0 ? '+' : ''}${mutation.effectValue}`;

        return h('div', {
            class: 'cf-card cf-mutation-card',
            style: {
                marginBottom: 'var(--space-2)',
                opacity: mutation.isDiscovered ? 1 : 0.4,
                borderLeft: `3px solid ${color}`
            }
        },
            h('div', { class: 'cf-card__body' },
                mutation.isDiscovered
                    ? h('div', {},
                        h('div', { class: 'font-semibold', style: { color } }, mutation.name),
                        h('p', { class: 'text-xs text-muted mb-1' }, mutation.description),
                        h('div', { class: 'text-xs' },
                            h('span', {
                                style: { color: mutation.isPositive ? 'var(--color-success)' : 'var(--color-danger)' }
                            }, `${effectLabel}: ${effectValue}`)
                        ),
                        mutation.timesDiscovered > 1 && h('div', { class: 'text-xs text-muted mt-1' },
                            `Discovered ${mutation.timesDiscovered}x`
                        )
                    )
                    : h('div', {},
                        h('div', { class: 'font-semibold text-muted' }, '???'),
                        h('p', { class: 'text-xs text-muted' }, 'Not yet discovered')
                    )
            )
        );
    }

    _renderActiveMutations() {
        if (this._activeMutations.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No active mutations'),
                h('p', { class: 'cf-empty__description' },
                    'Mutations can randomly appear on growing plants. Higher rarity strains have better chances!'
                )
            );
        }

        return h('div', { class: 'cf-active-mutations' },
            ...this._activeMutations.map(mutation => {
                const color = RARITY_COLORS[mutation.rarity] || '#666';
                const effectLabel = EFFECT_LABELS[mutation.effectType] || mutation.effectType;
                const effectValue = mutation.effectType.includes('bonus')
                    ? `${mutation.effectValue > 0 ? '+' : ''}${Math.round(mutation.effectValue * 100)}%`
                    : `${mutation.effectValue > 0 ? '+' : ''}${mutation.effectValue}`;

                return h('div', {
                    class: 'cf-card mb-2',
                    style: { borderLeft: `3px solid ${color}` }
                },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                            h('div', {},
                                h('div', { class: 'font-semibold', style: { color } }, mutation.name),
                                h('div', { class: 'text-xs text-muted' },
                                    `Slot ${mutation.slotNumber} - ${mutation.strainName || 'Unknown'}`
                                )
                            ),
                            h('div', { class: 'text-right' },
                                h('div', {
                                    class: 'text-sm',
                                    style: { color: mutation.isPositive ? 'var(--color-success)' : 'var(--color-danger)' }
                                }, effectValue),
                                h('div', { class: 'text-xs text-muted' }, effectLabel)
                            )
                        )
                    )
                );
            })
        );
    }
}

registerComponent('cf-mutations', CFMutations);
export default CFMutations;
