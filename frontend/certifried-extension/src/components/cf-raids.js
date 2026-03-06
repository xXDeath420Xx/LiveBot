/**
 * CertiFried Extension - Raids Component
 * DEA raids and defense system
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency } from '../utils/format.js';
import { store } from '../state/store.js';

class CFRaids extends CFBaseComponent {
    constructor() {
        super();
        this._raidStatus = null;
        this._raidHistory = [];
        this._defenses = [];
        this._loading = true;
        this._error = null;
        this._activeTab = 'status'; // 'status' | 'defenses' | 'history'
        this._activeRaid = null;
    }

    _setupSubscriptions() {
        this.subscribe('player');
        this.subscribe('heat');
    }

    async onMount() {
        await this._loadRaidStatus();

        // Tab switching
        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });

        // Buy defense
        this.on('click', '.cf-buy-defense', async (e) => {
            const btn = e.target.closest('.cf-buy-defense');
            if (!btn || btn.disabled) return;
            await this._buyDefense(btn.dataset.id);
        });

        // Defend action during raid
        this.on('click', '.cf-defend-action', async (e) => {
            const btn = e.target.closest('.cf-defend-action');
            if (!btn || btn.disabled) return;
            await this._useDefense(btn.dataset.defenseId);
        });

        // Bribe action
        this.on('click', '.cf-bribe-btn', async (e) => {
            const btn = e.target.closest('.cf-bribe-btn');
            if (!btn || btn.disabled) return;
            await this._bribeRaid();
        });
    }

    async _loadRaidStatus() {
        const isFirstLoad = !this._raidStatus;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.scheduleRender();
        }

        try {
            const response = await api.getRaidStatus();
            if (response.success !== false) {
                this._raidStatus = {
                    heatLevel: response.heatLevel ?? response.status?.heat?.current ?? 0,
                    raidChance: response.raidChance ?? Math.round((response.status?.heat?.actualChance || 0) * 100),
                    heatStatus: response.heatStatus ?? response.status?.heat?.status ?? 'cold',
                    totalRaids: response.totalRaids ?? 0,
                    successfulDefenses: response.successfulDefenses ?? 0,
                    totalCashLost: parseFloat(response.totalCashLost) || 0,
                    totalItemsSeized: response.totalItemsSeized ?? 0,
                    immunity: response.immunity || response.status?.immunity || null
                };
                this._activeRaid = response.activeRaid || null;
                this._defenses = response.defenses || [];

                // Populate store so heat indicator and other components work
                store.set('game.raidStatus', response.status || response);
                store.merge('heat', {
                    current: this._raidStatus.heatLevel,
                    status: this._raidStatus.heatStatus,
                    raidChance: this._raidStatus.raidChance
                });
            } else {
                this._error = response.error || 'Failed to load raid status';
            }
        } catch (err) {
            // If endpoint doesn't exist, provide mock data
            this._raidStatus = {
                heatLevel: this.getState('player.heat') || 0,
                raidChance: Math.min(100, (this.getState('player.heat') || 0) * 2),
                lastRaid: null,
                totalRaids: 0,
                successfulDefenses: 0
            };
            this._defenses = this._getMockDefenses();
        }

        // Load raid history from dedicated endpoint
        try {
            const historyResponse = await api.getRaidHistory();
            this._raidHistory = historyResponse.raids || [];
        } catch (err) {
            this._raidHistory = [];
        }

        this._loading = false;
        this.scheduleRender();
    }

    _getMockDefenses() {
        return [
            { id: 'alarm', name: 'Alarm System', icon: '🚨', cost: 5000, effect: 'Warns you 30s before raid', owned: false, level: 0, maxLevel: 3 },
            { id: 'safe', name: 'Hidden Safe', icon: '🔒', cost: 15000, effect: 'Protect 25% of cash', owned: false, level: 0, maxLevel: 5 },
            { id: 'tunnel', name: 'Escape Tunnel', icon: '🕳️', cost: 25000, effect: '20% chance to avoid raid', owned: false, level: 0, maxLevel: 3 },
            { id: 'lawyer', name: 'Lawyer Retainer', icon: '⚖️', cost: 50000, effect: 'Reduce penalties by 30%', owned: true, level: 1, maxLevel: 5 },
            { id: 'bribe', name: 'Police Contact', icon: '🤝', cost: 100000, effect: 'Can bribe to end raids', owned: false, level: 0, maxLevel: 1 },
            { id: 'decoy', name: 'Decoy Stash', icon: '📦', cost: 20000, effect: 'Save inventory from seizure', owned: false, level: 0, maxLevel: 3 }
        ];
    }

    async _buyDefense(defenseId) {
        const defense = this._defenses.find(d => d.id === defenseId);
        if (!defense) return;

        const player = this.getState('player') || {};
        const cash = player.currency || player.cash || 0;

        if (cash < defense.cost) {
            this.emit('notification', { type: 'error', message: 'Not enough cash' });
            return;
        }

        // Optimistic update
        const oldCash = cash;
        const oldDefenses = [...this._defenses];

        store.merge('player', { currency: cash - defense.cost, cash: cash - defense.cost });
        const idx = this._defenses.findIndex(d => d.id === defenseId);
        if (idx >= 0) {
            this._defenses[idx] = { ...this._defenses[idx], owned: true, level: this._defenses[idx].level + 1 };
        }
        this.scheduleRender();

        try {
            const response = await api.buyRaidDefense(defenseId);
            if (response.success) {
                this.emit('notification', {
                    type: 'success',
                    message: `Purchased ${defense.name}!`
                });
                await this._loadRaidStatus();
            } else {
                throw new Error(response.error || 'Purchase failed');
            }
        } catch (err) {
            // Rollback
            store.merge('player', { currency: oldCash, cash: oldCash });
            this._defenses = oldDefenses;
            this.emit('notification', { type: 'error', message: err.message });
            this.scheduleRender();
        }
    }

    async _useDefense(defenseId) {
        try {
            const response = await api.useRaidDefense(defenseId);
            if (response.success) {
                this.emit('notification', {
                    type: 'success',
                    message: response.message || 'Defense activated!'
                });
                await this._loadRaidStatus();
            } else {
                throw new Error(response.error || 'Defense failed');
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _bribeRaid() {
        const player = this.getState('player') || {};
        const cash = player.currency || player.cash || 0;
        const level = player.level || 1;
        const bribeCost = Math.floor(5000 * level * 0.5);

        if (cash < bribeCost) {
            this.emit('notification', { type: 'error', message: `Need ${formatCurrency(bribeCost)} for bribe` });
            return;
        }

        if (!confirm(`Pay ${formatCurrency(bribeCost)} to reduce heat by 50 and gain 6hr immunity?`)) {
            return;
        }

        try {
            const response = await api.bribeRaid();
            if (response.success) {
                store.merge('player', { currency: response.newCash, cash: response.newCash });
                this.emit('notification', {
                    type: 'success',
                    message: `Bribe accepted! -50 heat, 6hr immunity`
                });
                await this._loadRaidStatus();
            } else {
                throw new Error(response.error || 'Bribe failed');
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-raids';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        const heat = this._raidStatus?.heatLevel || this.getState('player.heat') || 0;
        const raidChance = this._raidStatus?.raidChance || Math.min(100, heat * 2);

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, 'Raids & Defense'),

            // Active raid warning
            this._activeRaid && this._renderActiveRaid(),

            // Heat status
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' } },
                        h('span', { class: 'text-sm' }, 'Heat Level'),
                        h('span', {
                            class: 'font-bold',
                            style: { color: this._getHeatColor(heat) }
                        }, `🔥 ${Math.round(heat)} — ${this._getHeatLabel(heat)}`)
                    ),
                    h('div', { class: 'cf-progress', style: { height: '8px' } },
                        h('div', {
                            class: 'cf-progress__bar',
                            style: {
                                width: `${Math.min(100, (heat / 200) * 100)}%`,
                                background: this._getHeatColor(heat)
                            }
                        })
                    ),
                    h('div', { class: 'text-xs text-muted mt-2' },
                        `Raid chance: ${raidChance}% per day`
                    )
                )
            ),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'status' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'status' }
                }, 'Status'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'defenses' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'defenses' }
                }, 'Defenses'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'history' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'history' }
                }, 'History')
            ),

            // Tab content
            this._activeTab === 'status' && this._renderStatusTab(),
            this._activeTab === 'defenses' && this._renderDefensesTab(),
            this._activeTab === 'history' && this._renderHistoryTab()
        );
    }

    _renderActiveRaid() {
        const raid = this._activeRaid;
        const timeLeft = raid.endsAt ? this._formatTimeLeft(new Date(raid.endsAt)) : '??:??';

        return h('div', {
            class: 'cf-card mb-3',
            style: {
                border: '2px solid var(--color-danger)',
                animation: 'pulse 1s infinite'
            }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { class: 'text-center' },
                    h('div', { style: { fontSize: '2rem' } }, '🚨'),
                    h('h3', { class: 'font-bold', style: { color: 'var(--color-danger)' } },
                        'RAID IN PROGRESS!'
                    ),
                    h('p', { class: 'text-sm text-muted mb-2' },
                        `DEA agents are searching your operation!`
                    ),
                    h('div', { class: 'font-mono text-lg mb-3' }, timeLeft),

                    // Actions
                    h('div', { style: { display: 'flex', gap: 'var(--space-2)', justifyContent: 'center' } },
                        this._defenses.filter(d => d.owned && d.id !== 'bribe').map(d =>
                            h('button', {
                                class: 'cf-btn cf-btn--sm cf-btn--secondary cf-defend-action',
                                dataset: { defenseId: d.id }
                            }, `${d.icon} Use ${d.name}`)
                        ),
                        this._defenses.find(d => d.id === 'bribe' && d.owned) &&
                        h('button', {
                            class: 'cf-btn cf-btn--sm cf-btn--warning cf-bribe-btn'
                        }, `🤝 Bribe (${formatCurrency(raid.bribeCost || 50000)})`)
                    )
                )
            )
        );
    }

    _renderStatusTab() {
        const stats = this._raidStatus;
        const ownedDefenses = this._defenses.filter(d => d.owned);

        return h('div', { class: 'cf-raids-status' },
            // Stats
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Statistics')
                ),
                h('div', { class: 'cf-card__body' },
                    h('div', {
                        style: {
                            display: 'grid',
                            gridTemplateColumns: 'repeat(2, 1fr)',
                            gap: 'var(--space-3)'
                        }
                    },
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Total Raids'),
                            h('div', { class: 'font-bold text-lg' }, stats?.totalRaids || 0)
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Defended'),
                            h('div', { class: 'font-bold text-lg', style: { color: 'var(--color-success)' } },
                                stats?.successfulDefenses || 0
                            )
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Cash Lost'),
                            h('div', { class: 'font-bold', style: { color: 'var(--color-danger)' } },
                                formatCurrency(stats?.totalCashLost || 0)
                            )
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Items Seized'),
                            h('div', { class: 'font-bold', style: { color: 'var(--color-danger)' } },
                                stats?.totalItemsSeized || 0
                            )
                        )
                    )
                )
            ),

            // Active defenses
            h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, `Active Defenses (${ownedDefenses.length})`)
                ),
                h('div', { class: 'cf-card__body' },
                    ownedDefenses.length === 0
                        ? h('p', { class: 'text-sm text-muted text-center' }, 'No defenses installed')
                        : ownedDefenses.map(d =>
                            h('div', {
                                style: {
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 'var(--space-2)',
                                    marginBottom: 'var(--space-2)'
                                }
                            },
                                h('span', {}, d.icon),
                                h('span', { class: 'font-semibold' }, d.name),
                                d.maxLevel > 1 && h('span', { class: 'text-xs text-muted' },
                                    `Lv.${d.level}/${d.maxLevel}`
                                )
                            )
                        )
                )
            ),

            // Immunity status
            stats?.immunity?.active && h('div', {
                class: 'cf-card mt-3',
                style: { border: '1px solid var(--color-success)' }
            },
                h('div', { class: 'cf-card__body text-center' },
                    h('div', { class: 'font-bold', style: { color: 'var(--color-success)' } }, '🛡️ RAID IMMUNITY ACTIVE'),
                    h('div', { class: 'text-xs text-muted mt-1' },
                        `Until ${new Date(stats.immunity.until).toLocaleString()}`
                    )
                )
            ),

            // Bribe button (when player owns bribe defense and has heat)
            this._defenses.find(d => d.id === 'bribe' && d.owned) && stats?.heatLevel > 0 &&
                !(stats?.immunity?.active) &&
                h('div', { class: 'cf-card mt-3' },
                    h('div', { class: 'cf-card__body text-center' },
                        h('button', { class: 'cf-btn cf-btn--warning cf-bribe-btn' },
                            `🤝 Bribe DEA — Reduce Heat & Gain Immunity`
                        )
                    )
                ),

            // Tips
            h('div', { class: 'cf-card mt-3' },
                h('div', { class: 'cf-card__body' },
                    h('h4', { class: 'font-semibold mb-2' }, '💡 Tips'),
                    h('ul', { class: 'text-sm text-muted', style: { paddingLeft: 'var(--space-4)' } },
                        h('li', {}, 'Lower heat by avoiding black market sales'),
                        h('li', {}, 'Use the Vault to protect cash and items'),
                        h('li', {}, 'Install defenses before heat gets too high'),
                        h('li', {}, 'Bribe the DEA for 6 hours of immunity')
                    )
                )
            )
        );
    }

    _renderDefensesTab() {
        const player = this.getState('player') || {};
        const cash = player.currency || player.cash || 0;

        return h('div', { class: 'cf-raids-defenses' },
            h('p', { class: 'text-sm text-muted mb-3' },
                `Available: ${formatCurrency(cash)}`
            ),
            ...this._defenses.map(defense => {
                // Backend already sends the correct next-level cost in defense.cost
                const canAfford = cash >= defense.cost;
                const isMaxed = defense.owned && defense.level >= defense.maxLevel;

                return h('div', {
                    class: 'cf-card mb-2',
                    style: { opacity: isMaxed ? 0.6 : 1 }
                },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                            h('div', { style: { fontSize: '1.5rem' } }, defense.icon),
                            h('div', { style: { flex: 1 } },
                                h('div', { class: 'font-semibold' },
                                    defense.name,
                                    defense.owned && h('span', {
                                        class: 'text-xs ml-2',
                                        style: { color: 'var(--color-success)' }
                                    }, `Lv.${defense.level}/${defense.maxLevel}`)
                                ),
                                h('div', { class: 'text-xs text-muted' }, defense.effect)
                            ),
                            !isMaxed && h('button', {
                                class: `cf-btn cf-btn--sm cf-buy-defense ${canAfford ? 'cf-btn--primary' : ''}`,
                                dataset: { id: defense.id },
                                disabled: !canAfford
                            }, defense.owned ? `Upgrade ${formatCurrency(defense.cost)}` : formatCurrency(defense.cost)),
                            isMaxed && h('span', { class: 'text-xs text-muted' }, 'MAX')
                        )
                    )
                );
            })
        );
    }

    _renderHistoryTab() {
        if (this._raidHistory.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Raid History'),
                h('p', { class: 'cf-empty__description' }, 'Keep your heat low to avoid raids!')
            );
        }

        return h('div', { class: 'cf-raids-history' },
            ...this._raidHistory.map(raid => {
                const defended = raid.defended || raid.success;
                const date = new Date(raid.timestamp || raid.date);

                return h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                            h('div', {},
                                h('div', {
                                    class: 'font-semibold',
                                    style: { color: defended ? 'var(--color-success)' : 'var(--color-danger)' }
                                },
                                    defended ? '✅ Defended' : '❌ Raided'
                                ),
                                h('div', { class: 'text-xs text-muted' },
                                    date.toLocaleDateString()
                                )
                            ),
                            defended && raid.defenseDetails && h('div', { class: 'text-right text-sm' },
                                h('div', { class: 'text-xs', style: { color: 'var(--color-success)' } },
                                    typeof raid.defenseDetails === 'object' && raid.defenseDetails.message
                                        ? raid.defenseDetails.message
                                        : 'Raid defended!'
                                )
                            ),
                            !defended && h('div', { class: 'text-right text-sm' },
                                raid.cashLost && h('div', { style: { color: 'var(--color-danger)' } },
                                    `-${formatCurrency(raid.cashLost)}`
                                ),
                                raid.itemsSeized && h('div', { class: 'text-xs text-muted' },
                                    `${raid.itemsSeized} items seized`
                                )
                            )
                        )
                    )
                );
            })
        );
    }

    _getHeatColor(heat) {
        if (heat >= 150) return 'var(--color-danger)';   // INFERNO
        if (heat >= 100) return '#ff6600';               // SCORCHING
        if (heat >= 50) return 'var(--color-warning)';   // HOT
        if (heat >= 25) return 'var(--color-epic)';      // WARM
        return 'var(--color-success)';                   // COLD
    }

    _getHeatLabel(heat) {
        if (heat >= 150) return 'INFERNO';
        if (heat >= 100) return 'SCORCHING';
        if (heat >= 50) return 'HOT';
        if (heat >= 25) return 'WARM';
        return 'COLD';
    }

    _formatTimeLeft(endDate) {
        const now = new Date();
        const diff = endDate - now;
        if (diff <= 0) return '00:00';

        const minutes = Math.floor(diff / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
}

registerComponent('cf-raids', CFRaids);
export default CFRaids;
