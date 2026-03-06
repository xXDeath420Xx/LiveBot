/**
 * CertiFried Extension - Permanent Unlocks Component
 * Shows all permanent unlocks that persist through prestiges
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatPercent } from '../utils/format.js';
import { api } from '../api/client.js';
import { store } from '../state/store.js';

// Unlock categories
const UNLOCK_CATEGORIES = {
    prestige: {
        name: 'Prestige Upgrades',
        icon: '⭐',
        description: 'Bought with prestige tokens',
        color: 'var(--color-legendary)'
    },
    achievements: {
        name: 'Achievement Bonuses',
        icon: '🏆',
        description: 'Earned through achievements',
        color: 'var(--color-epic)'
    },
    strains: {
        name: 'Discovered Strains',
        icon: '🧬',
        description: 'Permanently unlocked genetics',
        color: 'var(--color-success)'
    },
    reputation: {
        name: 'Reputation Tiers',
        icon: '🛡️',
        description: 'Faction standing rewards',
        color: 'var(--color-rare)'
    }
};

class CFPermanentUnlocks extends CFBaseComponent {
    constructor() {
        super();
        this._loading = true;
        this._error = null;
        this._unlocks = {
            prestige: [],
            achievements: [],
            strains: [],
            reputation: []
        };
        this._stats = {
            total: 0,
            prestigeLevel: 0,
            achievementCount: 0,
            strainCount: 0
        };
        this._activeTab = 'overview';
    }

    _setupSubscriptions() {
        this.subscribe('player');
    }

    async onMount() {
        await this._loadUnlocks();

        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });
    }

    async _loadUnlocks() {
        const isFirstLoad = this._stats.total === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const player = this.getState('player') || {};

            // Load from various sources
            const [prestigeRes, achievementsRes, strainsRes, reputationRes] = await Promise.all([
                api.getPrestigeInfo().catch(() => ({})),
                api.getAchievements().catch(() => ({ achievements: [] })),
                api.getStrainCollection().catch(() => ({ strains: [] })),
                api.getReputation().catch(() => ({ factions: [] }))
            ]);

            // Process prestige unlocks
            this._unlocks.prestige = (prestigeRes.purchasedUpgrades || prestigeRes.owned || []).map(u => ({
                id: u.id,
                name: u.name || 'Prestige Upgrade',
                description: u.description || '',
                effectType: u.effectType,
                effectValue: u.effectValue || u.value || 0,
                icon: this._getPrestigeIcon(u.effectType || u.type)
            }));

            // Process achievement unlocks (completed achievements with bonuses)
            this._unlocks.achievements = (achievementsRes.achievements || [])
                .filter(a => a.isComplete && a.bonus)
                .map(a => ({
                    id: a.id,
                    name: a.name,
                    description: a.bonus?.description || a.description,
                    effectType: a.bonus?.type,
                    effectValue: a.bonus?.value || 0,
                    icon: '🏆'
                }));

            // Process discovered strains
            const discoveredStrains = (strainsRes.strains || []).filter(s => s.isDiscovered);
            this._unlocks.strains = discoveredStrains.map(s => ({
                id: s.id,
                name: s.name,
                description: `${s.rarity || 'common'} strain`,
                rarity: s.rarity,
                icon: '🌿'
            }));

            // Process reputation tier rewards
            this._unlocks.reputation = [];
            (reputationRes.factions || []).forEach(faction => {
                const currentTier = faction.currentTier || 0;
                for (let i = 1; i <= currentTier; i++) {
                    const tierReward = faction.tiers?.[i - 1];
                    if (tierReward?.reward) {
                        this._unlocks.reputation.push({
                            id: `${faction.key}_t${i}`,
                            name: `${faction.name} Tier ${i}`,
                            description: tierReward.reward.description || '',
                            effectType: tierReward.reward.type,
                            effectValue: tierReward.reward.value || 0,
                            icon: faction.icon || '🛡️'
                        });
                    }
                }
            });

            // Calculate stats
            this._stats = {
                total: Object.values(this._unlocks).reduce((sum, arr) => sum + arr.length, 0),
                prestigeLevel: player.prestigeLevel || prestigeRes.level || 0,
                achievementCount: this._unlocks.achievements.length,
                strainCount: this._unlocks.strains.length
            };

        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    _getPrestigeIcon(type) {
        const icons = {
            starting_cash: '💰',
            xp_multiplier: '⭐',
            yield_multiplier: '🌿',
            quality_boost: '💎',
            grow_speed: '⚡',
            market_bonus: '📈',
            worker_efficiency: '👷',
            slot_unlock: '🌱',
            breeding_success: '🧬',
            heat_reduction: '🔥',
            extraction_yield: '🧪',
            boss_damage: '⚔️',
            tournament_bonus: '🏆',
            offline_earnings: '💤',
            daily_reward_boost: '🎁',
            reputation_gain: '🛡️'
        };
        return icons[type] || '✨';
    }

    render() {
        this.className = 'cf-permanent-unlocks';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadUnlocks() }, 'Retry')
                )
            );
            return;
        }

        const player = this.getState('player') || {};

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, '🔓 Permanent Unlocks'),

            // Stats summary
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__body' },
                    h('p', { class: 'text-sm text-muted text-center mb-3' },
                        'These bonuses persist through prestige resets!'
                    ),
                    h('div', {
                        style: {
                            display: 'flex',
                            justifyContent: 'space-around',
                            textAlign: 'center'
                        }
                    },
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-legendary)' } },
                                `⭐ ${this._stats.prestigeLevel}`
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Prestige Level')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-success)' } },
                                this._stats.total
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Total Unlocks')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-primary)' } },
                                `🪙 ${player.prestigeTokens || 0}`
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Tokens')
                        )
                    )
                )
            ),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'overview' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'overview' }
                }, 'Overview'),
                ...Object.entries(UNLOCK_CATEGORIES).map(([key, cat]) => {
                    const count = this._unlocks[key]?.length || 0;
                    return h('button', {
                        class: `cf-tab cf-tab-btn ${this._activeTab === key ? 'cf-tab--active' : ''}`,
                        dataset: { tab: key }
                    }, `${cat.icon} ${count}`);
                })
            ),

            // Tab content
            this._activeTab === 'overview' && this._renderOverviewTab(),
            this._activeTab !== 'overview' && this._renderCategoryTab(this._activeTab)
        );
    }

    _renderOverviewTab() {
        // Aggregate all bonuses by type
        const bonusesByType = {};

        Object.values(this._unlocks).forEach(category => {
            category.forEach(unlock => {
                if (unlock.effectType && unlock.effectValue) {
                    if (!bonusesByType[unlock.effectType]) {
                        bonusesByType[unlock.effectType] = {
                            type: unlock.effectType,
                            total: 0,
                            sources: []
                        };
                    }
                    bonusesByType[unlock.effectType].total += unlock.effectValue;
                    bonusesByType[unlock.effectType].sources.push(unlock.name);
                }
            });
        });

        const aggregatedBonuses = Object.values(bonusesByType).sort((a, b) => b.total - a.total);

        if (aggregatedBonuses.length === 0 && this._stats.strainCount === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Permanent Unlocks Yet'),
                h('p', { class: 'cf-empty__description' },
                    'Prestige, complete achievements, and discover strains to earn permanent bonuses!'
                )
            );
        }

        return h('div', { class: 'cf-permanent-overview' },
            // Active bonuses
            aggregatedBonuses.length > 0 && h('div', { class: 'mb-4' },
                h('h3', { class: 'text-sm font-semibold mb-2' }, 'Total Permanent Bonuses'),
                ...aggregatedBonuses.map(bonus => {
                    const isPercent = bonus.total < 10;
                    const display = isPercent
                        ? `+${Math.round(bonus.total * 100)}%`
                        : `+${bonus.total}`;

                    return h('div', { class: 'cf-card mb-2' },
                        h('div', { class: 'cf-card__body' },
                            h('div', {
                                style: {
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center'
                                }
                            },
                                h('div', {},
                                    h('div', { class: 'font-semibold' },
                                        this._formatBonusType(bonus.type)
                                    ),
                                    h('div', { class: 'text-xs text-muted' },
                                        `From ${bonus.sources.length} source${bonus.sources.length > 1 ? 's' : ''}`
                                    )
                                ),
                                h('div', {
                                    class: 'font-bold',
                                    style: { color: 'var(--color-success)', fontSize: '1.1rem' }
                                }, display)
                            )
                        )
                    );
                })
            ),

            // Strains count
            this._stats.strainCount > 0 && h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__body text-center' },
                    h('div', { style: { fontSize: '2rem' } }, '🌿'),
                    h('div', { class: 'font-bold' }, `${this._stats.strainCount} Strains Discovered`),
                    h('div', { class: 'text-xs text-muted' },
                        'These will be available after prestige'
                    )
                )
            )
        );
    }

    _renderCategoryTab(category) {
        const unlocks = this._unlocks[category] || [];
        const catInfo = UNLOCK_CATEGORIES[category] || {};

        if (unlocks.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, `No ${catInfo.name}`),
                h('p', { class: 'cf-empty__description' }, catInfo.description)
            );
        }

        // Special rendering for strains
        if (category === 'strains') {
            return this._renderStrainsGrid(unlocks);
        }

        return h('div', { class: 'cf-unlocks-list' },
            ...unlocks.map(unlock => this._renderUnlockCard(unlock, catInfo))
        );
    }

    _renderUnlockCard(unlock, catInfo) {
        const hasEffect = unlock.effectType && unlock.effectValue;
        const effectDisplay = hasEffect
            ? (unlock.effectValue < 10
                ? `+${Math.round(unlock.effectValue * 100)}%`
                : `+${unlock.effectValue}`)
            : null;

        return h('div', {
            class: 'cf-card mb-2',
            style: { borderLeft: `3px solid ${catInfo.color}` }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                    h('span', { style: { fontSize: '1.5rem' } }, unlock.icon),
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' }, unlock.name),
                        h('div', { class: 'text-xs text-muted' }, unlock.description)
                    ),
                    hasEffect && h('div', {
                        class: 'font-bold',
                        style: { color: 'var(--color-success)' }
                    }, effectDisplay)
                )
            )
        );
    }

    _renderStrainsGrid(strains) {
        const RARITY_COLORS = {
            common: '#9ca3af',
            uncommon: '#22c55e',
            rare: '#3b82f6',
            epic: '#a855f7',
            legendary: '#f59e0b'
        };

        return h('div', {
            style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
                gap: 'var(--space-2)'
            }
        },
            ...strains.map(strain => {
                const color = RARITY_COLORS[strain.rarity] || RARITY_COLORS.common;
                return h('div', {
                    class: 'cf-card',
                    style: { borderTop: `3px solid ${color}`, textAlign: 'center' }
                },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { fontSize: '1.5rem' } }, '🌿'),
                        h('div', { class: 'text-xs font-semibold' }, strain.name),
                        h('div', { class: 'text-xs', style: { color } }, strain.rarity)
                    )
                );
            })
        );
    }

    _formatBonusType(type) {
        const labels = {
            starting_cash: 'Starting Cash',
            xp_multiplier: 'XP Multiplier',
            yield_multiplier: 'Yield Bonus',
            quality_boost: 'Quality Boost',
            grow_speed: 'Grow Speed',
            market_bonus: 'Market Prices',
            worker_efficiency: 'Worker Efficiency',
            slot_unlock: 'Extra Slots',
            breeding_success: 'Breeding Success',
            heat_reduction: 'Heat Reduction',
            extraction_yield: 'Extraction Yield',
            boss_damage: 'Boss Damage',
            tournament_bonus: 'Tournament Bonus',
            offline_earnings: 'Offline Earnings',
            daily_reward_boost: 'Daily Rewards',
            reputation_gain: 'Reputation Gain'
        };
        return labels[type] || type.replace(/_/g, ' ');
    }
}

registerComponent('cf-permanent-unlocks', CFPermanentUnlocks);
export default CFPermanentUnlocks;
