/**
 * CertiFried Extension - Breeding History Component
 * View past breeding results and genetics tree
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatRelativeTime } from '../utils/format.js';
import { api } from '../api/client.js';

const RARITY_COLORS = {
    common: '#9ca3af',
    uncommon: '#22c55e',
    rare: '#3b82f6',
    epic: '#a855f7',
    legendary: '#f59e0b'
};

class CFBreedingHistory extends CFBaseComponent {
    constructor() {
        super();
        this._history = [];
        this._loading = true;
        this._error = null;
        this._activeTab = 'history'; // 'history' | 'genetics' | 'stats'
        this._selectedResult = null;
        this._stats = {
            totalBreeds: 0,
            successRate: 0,
            mutationCount: 0,
            rarityBreakdown: {}
        };
    }

    async onMount() {
        await this._loadHistory();

        // Tab switching
        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });

        // View result details
        this.on('click', '.cf-breeding-result', (e) => {
            const card = e.target.closest('.cf-breeding-result');
            if (!card) return;
            const idx = parseInt(card.dataset.idx, 10);
            this._selectedResult = this._history[idx];
            this.render();
        });

        // Close detail view
        this.on('click', '.cf-result-back', () => {
            this._selectedResult = null;
            this.render();
        });
    }

    async _loadHistory() {
        const isFirstLoad = this._history.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getBreedingHistory();
            if (response && response.success !== false) {
                this._history = response.history || response.results || [];
            } else {
                this._history = [];
            }
            this._computeStats();
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    _computeStats() {
        const total = this._history.length;
        const mutations = this._history.filter(h => h.hasMutation).length;
        const rarityBreakdown = {};

        this._history.forEach(result => {
            const rarity = result.resultRarity || result.rarity || 'common';
            rarityBreakdown[rarity] = (rarityBreakdown[rarity] || 0) + 1;
        });

        this._stats = {
            totalBreeds: total,
            successRate: total > 0 ? 100 : 0, // All completed breeds are successes
            mutationCount: mutations,
            mutationRate: total > 0 ? Math.round((mutations / total) * 100) : 0,
            rarityBreakdown
        };
    }

    render() {
        this.className = 'cf-breeding-history';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadHistory() }, 'Retry')
                )
            );
            return;
        }

        if (this._selectedResult) {
            this.setContent(this._renderResultDetail());
            return;
        }

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, '🧬 Breeding History'),

            // Summary stats
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__body' },
                    h('div', {
                        style: {
                            display: 'flex',
                            justifyContent: 'space-around',
                            textAlign: 'center'
                        }
                    },
                        h('div', {},
                            h('div', { class: 'text-lg font-bold' }, this._stats.totalBreeds),
                            h('div', { class: 'text-xs text-muted' }, 'Total Breeds')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-epic)' } },
                                this._stats.mutationCount
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Mutations')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-legendary)' } },
                                `${this._stats.mutationRate}%`
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Mutation Rate')
                        )
                    )
                )
            ),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'history' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'history' }
                }, 'History'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'genetics' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'genetics' }
                }, 'Genetics'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'stats' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'stats' }
                }, 'Stats')
            ),

            this._activeTab === 'history' && this._renderHistoryTab(),
            this._activeTab === 'genetics' && this._renderGeneticsTab(),
            this._activeTab === 'stats' && this._renderStatsTab()
        );
    }

    _renderHistoryTab() {
        if (this._history.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Breeding History'),
                h('p', { class: 'cf-empty__description' },
                    'Complete breeding operations to see results here'
                )
            );
        }

        return h('div', { class: 'cf-breeding-list' },
            ...this._history.slice(0, 20).map((result, idx) => this._renderResultCard(result, idx))
        );
    }

    _renderResultCard(result, idx) {
        const rarity = result.resultRarity || result.rarity || 'common';
        const color = RARITY_COLORS[rarity] || RARITY_COLORS.common;

        return h('div', {
            class: 'cf-card cf-breeding-result mb-2',
            dataset: { idx: idx.toString() },
            style: { cursor: 'pointer', borderLeft: `3px solid ${color}` }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                    h('div', {
                        style: {
                            width: '40px',
                            height: '40px',
                            background: 'var(--bg-tertiary)',
                            borderRadius: 'var(--radius-full)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '1.25rem'
                        }
                    }, result.hasMutation ? '✨' : '🌿'),
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold', style: { color } },
                            result.resultStrainName || result.strainName || 'Unknown Strain'
                        ),
                        h('div', { class: 'text-xs text-muted' },
                            `${result.parent1Name || 'Parent 1'} × ${result.parent2Name || 'Parent 2'}`
                        ),
                        result.hasMutation && h('span', {
                            class: 'text-xs',
                            style: {
                                background: 'var(--color-epic)',
                                padding: '1px 6px',
                                borderRadius: 'var(--radius-sm)',
                                marginTop: 'var(--space-1)',
                                display: 'inline-block'
                            }
                        }, 'Mutation!')
                    ),
                    h('div', { class: 'text-xs text-muted' },
                        result.completedAt ? formatRelativeTime(result.completedAt) : ''
                    ),
                    h('span', { style: { color: 'var(--text-muted)' } }, '→')
                )
            )
        );
    }

    _renderResultDetail() {
        const result = this._selectedResult;
        const rarity = result.resultRarity || result.rarity || 'common';
        const color = RARITY_COLORS[rarity] || RARITY_COLORS.common;

        return h('div', { class: 'cf-result-detail' },
            h('button', { class: 'cf-btn cf-btn--ghost cf-result-back mb-3' }, '← Back'),

            // Result header
            h('div', { class: 'cf-card mb-3', style: { borderLeft: `4px solid ${color}` } },
                h('div', { class: 'cf-card__body text-center' },
                    h('div', { style: { fontSize: '3rem', marginBottom: 'var(--space-2)' } },
                        result.hasMutation ? '✨' : '🌿'
                    ),
                    h('h3', { class: 'font-bold', style: { color } },
                        result.resultStrainName || result.strainName || 'Unknown'
                    ),
                    h('div', {
                        class: 'text-sm',
                        style: {
                            display: 'inline-block',
                            padding: 'var(--space-1) var(--space-2)',
                            background: color,
                            borderRadius: 'var(--radius-full)',
                            marginTop: 'var(--space-1)'
                        }
                    }, rarity.charAt(0).toUpperCase() + rarity.slice(1))
                )
            ),

            // Parents
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Parents')
                ),
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 'var(--space-3)' } },
                        h('div', { class: 'text-center' },
                            h('div', { style: { fontSize: '1.5rem' } }, '🌿'),
                            h('div', { class: 'text-sm font-semibold' }, result.parent1Name || 'Parent 1')
                        ),
                        h('span', { style: { fontSize: '1.5rem' } }, '×'),
                        h('div', { class: 'text-center' },
                            h('div', { style: { fontSize: '1.5rem' } }, '🌿'),
                            h('div', { class: 'text-sm font-semibold' }, result.parent2Name || 'Parent 2')
                        )
                    )
                )
            ),

            // Traits inherited
            result.traits && result.traits.length > 0 && h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Inherited Traits')
                ),
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' } },
                        ...result.traits.map(trait =>
                            h('span', {
                                class: 'text-sm',
                                style: {
                                    padding: 'var(--space-1) var(--space-2)',
                                    background: 'var(--bg-tertiary)',
                                    borderRadius: 'var(--radius-md)'
                                }
                            }, trait.name || trait)
                        )
                    )
                )
            ),

            // Genetics/Stats
            h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Genetics')
                ),
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-2)' } },
                        this._renderGeneStat('THC', result.thc || result.genetics?.thc || '??'),
                        this._renderGeneStat('CBD', result.cbd || result.genetics?.cbd || '??'),
                        this._renderGeneStat('Yield', result.yield || result.genetics?.yield || '??'),
                        this._renderGeneStat('Quality', result.quality || result.genetics?.quality || '??')
                    )
                )
            )
        );
    }

    _renderGeneStat(label, value) {
        return h('div', {
            style: {
                display: 'flex',
                justifyContent: 'space-between',
                padding: 'var(--space-1)',
                background: 'var(--bg-tertiary)',
                borderRadius: 'var(--radius-sm)'
            }
        },
            h('span', { class: 'text-sm' }, label),
            h('span', { class: 'text-sm font-bold' }, typeof value === 'number' ? `${value}%` : value)
        );
    }

    _renderGeneticsTab() {
        // Build a simple genetics tree from breeding results
        const strainParents = {};
        this._history.forEach(result => {
            const name = result.resultStrainName || result.strainName;
            if (name) {
                strainParents[name] = {
                    parent1: result.parent1Name,
                    parent2: result.parent2Name,
                    rarity: result.resultRarity || result.rarity
                };
            }
        });

        const strains = Object.keys(strainParents);

        if (strains.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Genetics Data'),
                h('p', { class: 'cf-empty__description' }, 'Complete breeds to build your genetics tree')
            );
        }

        return h('div', { class: 'cf-genetics-tree' },
            h('p', { class: 'text-sm text-muted mb-3' }, 'Your bred strains and their lineage'),
            ...strains.map(strain => {
                const info = strainParents[strain];
                const color = RARITY_COLORS[info.rarity] || RARITY_COLORS.common;

                return h('div', { class: 'cf-card mb-2', style: { borderLeft: `3px solid ${color}` } },
                    h('div', { class: 'cf-card__body' },
                        h('div', { class: 'font-semibold', style: { color } }, strain),
                        h('div', { class: 'text-xs text-muted' },
                            `${info.parent1 || '?'} × ${info.parent2 || '?'}`
                        )
                    )
                );
            })
        );
    }

    _renderStatsTab() {
        const breakdown = this._stats.rarityBreakdown;

        return h('div', { class: 'cf-breeding-stats' },
            // Rarity breakdown
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Rarity Distribution')
                ),
                h('div', { class: 'cf-card__body' },
                    Object.keys(breakdown).length === 0
                        ? h('p', { class: 'text-muted text-center' }, 'No data yet')
                        : h('div', {},
                            ...Object.entries(breakdown).map(([rarity, count]) => {
                                const color = RARITY_COLORS[rarity] || RARITY_COLORS.common;
                                const percent = this._stats.totalBreeds > 0
                                    ? Math.round((count / this._stats.totalBreeds) * 100)
                                    : 0;

                                return h('div', { class: 'mb-2' },
                                    h('div', {
                                        style: {
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            marginBottom: 'var(--space-1)'
                                        }
                                    },
                                        h('span', { style: { color } },
                                            rarity.charAt(0).toUpperCase() + rarity.slice(1)
                                        ),
                                        h('span', { class: 'text-sm' }, `${count} (${percent}%)`)
                                    ),
                                    h('div', { class: 'cf-progress', style: { height: '6px' } },
                                        h('div', {
                                            class: 'cf-progress__bar',
                                            style: { width: `${percent}%`, background: color }
                                        })
                                    )
                                );
                            })
                        )
                )
            ),

            // Tips
            h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Breeding Tips')
                ),
                h('div', { class: 'cf-card__body' },
                    h('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } },
                        h('li', { class: 'text-sm mb-2' }, '💎 Higher rarity parents = better offspring'),
                        h('li', { class: 'text-sm mb-2' }, '✨ Mutations are random but increase with prestige'),
                        h('li', { class: 'text-sm mb-2' }, '🧬 Genetics lab equipment improves success rates'),
                        h('li', { class: 'text-sm mb-2' }, '⏰ Some strains breed faster than others')
                    )
                )
            )
        );
    }
}

registerComponent('cf-breeding-history', CFBreedingHistory);
export default CFBreedingHistory;
