/**
 * CertiFried Extension - Territories Component
 * View and capture territories for bonuses
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency } from '../utils/format.js';

class CFTerritories extends CFBaseComponent {
    constructor() {
        super();
        this._territories = [];
        this._activeWars = [];
        this._playerCartel = null;
        this._inCartel = false;
        this._loading = true;
        this._error = null;
        this._activeTab = 'territories'; // 'territories' | 'wars'
        this._selectedTerritory = null;
        this._attackInProgress = false;
    }

    _setupSubscriptions() {
        this.subscribe('player');
        this.subscribe('cartel');
    }

    async onMount() {
        await this._loadTerritories();

        // Tab switching
        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });

        // Attack territory
        this.on('click', '.cf-attack-btn', async (e) => {
            const btn = e.target.closest('.cf-attack-btn');
            if (!btn || btn.disabled) return;
            await this._attackTerritory(parseInt(btn.dataset.id, 10));
        });

        // Contribute to war
        this.on('click', '.cf-contribute-war', async (e) => {
            const btn = e.target.closest('.cf-contribute-war');
            if (!btn || btn.disabled) return;
            const warId = parseInt(btn.dataset.warId, 10);
            const type = btn.dataset.type; // 'cash' or 'troops'
            await this._contributeToWar(warId, type);
        });

        // View territory details
        this.on('click', '.cf-territory-card', (e) => {
            const card = e.target.closest('.cf-territory-card');
            if (!card || e.target.closest('.cf-attack-btn')) return;
            const id = parseInt(card.dataset.id, 10);
            this._selectedTerritory = this._territories.find(t => t.id === id);
            this.render();
        });

        // Close detail view
        this.on('click', '.cf-detail-back', () => {
            this._selectedTerritory = null;
            this.render();
        });
    }

    async _loadTerritories() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._territories.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.scheduleRender();
        }

        try {
            const response = await api.getTerritories();
            if (response.success !== false) {
                this._territories = response.territories || response || [];
                this._activeWars = response.activeWars || [];
                this._playerCartel = response.playerCartel || null;
                this._inCartel = response.inCartel || !!response.playerCartel;
            } else {
                this._error = response.error || 'Failed to load territories';
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    async _attackTerritory(territoryId) {
        if (this._attackInProgress) return;

        const territory = this._territories.find(t => t.id === territoryId);
        if (!territory) return;

        this._attackInProgress = true;
        this.scheduleRender();

        try {
            const response = await api.attackTerritory(territoryId);
            if (response.success) {
                this.emit('notification', {
                    type: 'success',
                    message: response.message || `Attack initiated on ${territory.name}!`
                });
                // Reload to get updated war status
                await this._loadTerritories();
            } else {
                this.emit('notification', {
                    type: 'error',
                    message: response.error || 'Attack failed'
                });
            }
        } catch (err) {
            this.emit('notification', {
                type: 'error',
                message: err.message || 'Attack failed'
            });
        }

        this._attackInProgress = false;
        this.scheduleRender();
    }

    async _contributeToWar(warId, contributionType) {
        try {
            const amount = contributionType === 'cash' ? 10000 : 1;
            const response = await api.contributeToWar(warId, contributionType, amount);
            if (response.success) {
                this.emit('notification', {
                    type: 'success',
                    message: response.message || 'Contribution added!'
                });
                await this._loadTerritories();
            } else {
                this.emit('notification', {
                    type: 'error',
                    message: response.error || 'Contribution failed'
                });
            }
        } catch (err) {
            this.emit('notification', {
                type: 'error',
                message: err.message || 'Contribution failed'
            });
        }
    }

    render() {
        this.className = 'cf-territories';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadTerritories() }, 'Retry')
                )
            );
            return;
        }

        // Detail view
        if (this._selectedTerritory) {
            this.setContent(this._renderDetailView());
            return;
        }

        // Main view
        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, 'Territories'),
            h('p', { class: 'text-sm text-muted mb-3' },
                'Control territories for powerful cartel bonuses!'
            ),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'territories' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'territories' }
                }, `Territories (${this._territories.length})`),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'wars' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'wars' }
                }, `Active Wars (${this._activeWars.length})`)
            ),

            // Content
            this._activeTab === 'territories' && this._renderTerritoriesTab(),
            this._activeTab === 'wars' && this._renderWarsTab()
        );
    }

    _renderTerritoriesTab() {
        if (this._territories.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No territories available'),
                h('p', { class: 'cf-empty__description' }, 'Check back later!')
            );
        }

        // Group by status
        const controlled = this._territories.filter(t => t.isOwned || t.is_owned);
        const contested = this._territories.filter(t => t.isContested || t.is_contested);
        const available = this._territories.filter(t =>
            !t.isOwned && !t.is_owned && !t.isContested && !t.is_contested
        );

        return h('div', { class: 'cf-territories-list' },
            // Controlled territories
            controlled.length > 0 && h('div', { class: 'mb-4' },
                h('h3', { class: 'text-sm font-semibold text-muted mb-2' },
                    `Your Territories (${controlled.length})`
                ),
                ...controlled.map(t => this._renderTerritoryCard(t, 'controlled'))
            ),

            // Contested territories
            contested.length > 0 && h('div', { class: 'mb-4' },
                h('h3', { class: 'text-sm font-semibold mb-2', style: { color: 'var(--color-warning)' } },
                    `Under Attack (${contested.length})`
                ),
                ...contested.map(t => this._renderTerritoryCard(t, 'contested'))
            ),

            // Available territories
            available.length > 0 && h('div', {},
                h('h3', { class: 'text-sm font-semibold text-muted mb-2' },
                    `Available (${available.length})`
                ),
                ...available.map(t => this._renderTerritoryCard(t, 'available'))
            )
        );
    }

    _renderTerritoryCard(territory, status) {
        const t = territory;
        const bonusType = t.bonusType || t.bonus_type || 'unknown';
        const bonusValue = t.bonusValue || t.bonus_value || 0;
        const ownerName = t.ownerName || t.owner_name || 'Unclaimed';
        const ownerCartel = t.ownerCartelName || t.owner_cartel_name;
        const defenseLevel = t.defenseLevel || t.defense_level || 0;

        let statusColor = 'var(--text-muted)';
        let statusText = 'Unclaimed';
        if (status === 'controlled') {
            statusColor = 'var(--color-success)';
            statusText = 'Controlled';
        } else if (status === 'contested') {
            statusColor = 'var(--color-warning)';
            statusText = 'Under Attack';
        } else if (ownerCartel) {
            statusColor = 'var(--color-danger)';
            statusText = `Owned by ${ownerCartel}`;
        }

        const canAttack = status !== 'controlled' && status !== 'contested';
        const inCartel = this._inCartel;

        return h('div', {
            class: 'cf-card cf-territory-card mb-2',
            dataset: { id: t.id?.toString() },
            style: { cursor: 'pointer' }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' },
                            h('span', { style: { marginRight: 'var(--space-2)' } }, this._getTerritoryIcon(bonusType)),
                            t.name || 'Unknown Territory'
                        ),
                        h('div', { class: 'text-xs text-muted' },
                            `+${Math.round(bonusValue * 100)}% ${this._formatBonusType(bonusType)}`
                        ),
                        h('div', { class: 'text-xs mt-1', style: { color: statusColor } }, statusText),
                        defenseLevel > 0 && h('div', { class: 'text-xs text-muted' },
                            `Defense: ${defenseLevel}`
                        )
                    ),
                    canAttack && inCartel && h('button', {
                        class: 'cf-btn cf-btn--sm cf-btn--danger cf-attack-btn',
                        dataset: { id: t.id?.toString() },
                        disabled: this._attackInProgress
                    }, this._attackInProgress ? '...' : 'Attack')
                )
            )
        );
    }

    _renderWarsTab() {
        if (this._activeWars.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No active wars'),
                h('p', { class: 'cf-empty__description' }, 'Attack a territory to start one!')
            );
        }

        return h('div', { class: 'cf-wars-list' },
            ...this._activeWars.map(war => this._renderWarCard(war))
        );
    }

    _renderWarCard(war) {
        const w = war;
        // Handle both nested object format (attacker.name) and flat format (attackerCartelName)
        const attackerName = w.attacker?.name || w.attackerCartelName || w.attacker_cartel_name || 'Unknown Cartel';
        const defenderName = w.defender?.name || w.defenderCartelName || w.defender_cartel_name || 'Unclaimed';
        const territoryName = w.territory?.name || w.territoryName || w.territory_name || 'Unknown Territory';
        const attackerPower = w.attacker?.score || w.attackerScore || w.attackerPower || w.attacker_power || w.attacker_score || 0;
        const defenderPower = w.defender?.score || w.defenderScore || w.defenderPower || w.defender_power || w.defender_score || 0;
        const totalPower = attackerPower + defenderPower || 1;
        const attackerPercent = Math.round((attackerPower / totalPower) * 100);
        const endsAt = w.endsAt || w.ends_at;
        const timeLeft = endsAt ? this._formatTimeLeft(new Date(endsAt)) : 'Unknown';
        const isOurWar = w.isOurs || w.is_ours;

        return h('div', { class: 'cf-card mb-2' },
            h('div', { class: 'cf-card__body' },
                h('div', { class: 'font-semibold mb-2' },
                    `Battle for ${territoryName}`
                ),

                // War progress
                h('div', { class: 'mb-2' },
                    h('div', { class: 'text-xs mb-1', style: { display: 'flex', justifyContent: 'space-between' } },
                        h('span', { style: { color: 'var(--color-danger)' } }, attackerName),
                        h('span', { style: { color: 'var(--color-success)' } }, defenderName)
                    ),
                    h('div', {
                        class: 'cf-progress',
                        style: { height: '8px', background: 'var(--color-success-muted)' }
                    },
                        h('div', {
                            class: 'cf-progress__bar',
                            style: {
                                width: `${attackerPercent}%`,
                                background: 'var(--color-danger)'
                            }
                        })
                    ),
                    h('div', { class: 'text-xs text-center mt-1' },
                        `${attackerPower.toLocaleString()} vs ${defenderPower.toLocaleString()}`
                    )
                ),

                // Time remaining
                h('div', { class: 'text-xs text-muted text-center mb-2' },
                    `Ends in: ${timeLeft}`
                ),

                // Contribute buttons (only for wars we're in)
                isOurWar && h('div', { style: { display: 'flex', gap: 'var(--space-2)' } },
                    h('button', {
                        class: 'cf-btn cf-btn--sm cf-btn--primary cf-contribute-war',
                        dataset: { warId: w.id?.toString(), type: 'cash' },
                        style: { flex: 1 },
                        title: 'Contribute $10,000 for 100 war points'
                    }, '+$10K'),
                    h('button', {
                        class: 'cf-btn cf-btn--sm cf-btn--secondary cf-contribute-war',
                        dataset: { warId: w.id?.toString(), type: 'troops' },
                        style: { flex: 1 },
                        title: 'Send troops for $5,000 (10 war points)'
                    }, '+Troops')
                )
            )
        );
    }

    _renderDetailView() {
        const t = this._selectedTerritory;
        const bonusType = t.bonusType || t.bonus_type || 'unknown';
        const bonusValue = t.bonusValue || t.bonus_value || 0;
        const ownerCartel = t.ownerCartelName || t.owner_cartel_name;
        const defenseLevel = t.defenseLevel || t.defense_level || 0;
        const description = t.description || 'A valuable piece of turf.';

        return h('div', { class: 'cf-territory-detail' },
            h('button', { class: 'cf-btn cf-btn--ghost cf-detail-back mb-3' },
                '← Back to Territories'
            ),

            h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__body' },
                    h('div', { class: 'text-center mb-3' },
                        h('div', { style: { fontSize: '3rem' } }, this._getTerritoryIcon(bonusType)),
                        h('h3', { class: 'font-semibold mt-2' }, t.name),
                        h('p', { class: 'text-sm text-muted' }, description)
                    ),

                    h('div', {
                        class: 'cf-stats-grid mb-3',
                        style: {
                            display: 'grid',
                            gridTemplateColumns: 'repeat(2, 1fr)',
                            gap: 'var(--space-3)'
                        }
                    },
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Bonus'),
                            h('div', { class: 'font-semibold', style: { color: 'var(--color-success)' } },
                                `+${Math.round(bonusValue * 100)}%`
                            ),
                            h('div', { class: 'text-xs text-muted' }, this._formatBonusType(bonusType))
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Defense'),
                            h('div', { class: 'font-semibold' }, defenseLevel || 0)
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Status'),
                            h('div', { class: 'font-semibold' },
                                ownerCartel ? `Owned by ${ownerCartel}` : 'Unclaimed'
                            )
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Attackers Needed'),
                            h('div', { class: 'font-semibold' }, t.attackersNeeded || t.attackers_needed || 3)
                        )
                    )
                )
            )
        );
    }

    _getTerritoryIcon(bonusType) {
        const icons = {
            cash: '💰',
            money: '💰',
            income: '💰',
            xp: '⭐',
            experience: '⭐',
            yield: '🌿',
            grow: '🌿',
            growth: '🌿',
            quality: '💎',
            speed: '⚡',
            defense: '🛡️',
            attack: '⚔️',
            default: '🚩'
        };
        return icons[bonusType?.toLowerCase()] || icons.default;
    }

    _formatBonusType(type) {
        if (!type) return 'Bonus';
        return type
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    _formatTimeLeft(endDate) {
        const now = new Date();
        const diff = endDate - now;
        if (diff <= 0) return 'Ending soon';

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }
        return `${minutes}m`;
    }
}

registerComponent('cf-territories', CFTerritories);
export default CFTerritories;
