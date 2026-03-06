/**
 * CertiFried Extension - Prestige Component
 * Full prestige system with shop and permanent upgrades
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency } from '../utils/format.js';
import { store } from '../state/store.js';

// Prestige upgrade definitions with icons and descriptions
const PRESTIGE_UPGRADES = {
    starting_cash: { icon: '💰', name: 'Starting Bonus', desc: 'Start with more cash after prestige' },
    xp_multiplier: { icon: '⭐', name: 'XP Boost', desc: 'Earn more XP from all sources' },
    yield_multiplier: { icon: '🌿', name: 'Harvest Master', desc: 'Increased harvest yields' },
    quality_boost: { icon: '💎', name: 'Quality Expert', desc: 'Higher base quality on grows' },
    grow_speed: { icon: '⚡', name: 'Speed Grower', desc: 'Faster grow times' },
    market_bonus: { icon: '📈', name: 'Market Insider', desc: 'Better market prices' },
    worker_efficiency: { icon: '👷', name: 'Worker Training', desc: 'Workers are more effective' },
    slot_unlock: { icon: '🌱', name: 'Extra Slot', desc: 'Unlock additional grow slot' },
    breeding_success: { icon: '🧬', name: 'Breeding Mastery', desc: 'Higher breeding success rate' },
    heat_reduction: { icon: '🔥', name: 'Low Profile', desc: 'Reduced heat generation' },
    extraction_yield: { icon: '🧪', name: 'Lab Efficiency', desc: 'Better extraction yields' },
    boss_damage: { icon: '⚔️', name: 'Boss Slayer', desc: 'Deal more damage to bosses' },
    tournament_bonus: { icon: '🏆', name: 'Champion', desc: 'Bonus tournament rewards' },
    offline_earnings: { icon: '💤', name: 'Passive Income', desc: 'Earn more while offline' },
    daily_reward_boost: { icon: '🎁', name: 'Lucky Streak', desc: 'Better daily rewards' },
    reputation_gain: { icon: '🛡️', name: 'Influencer', desc: 'Gain reputation faster' },
    default: { icon: '✨', name: 'Upgrade', desc: 'Permanent improvement' }
};

class CFPrestige extends CFBaseComponent {
    constructor() {
        super();
        this._prestigeInfo = null;
        this._upgrades = [];
        this._purchasedUpgrades = [];
        this._loading = true;
        this._error = null;
        this._activeTab = 'status'; // 'status' | 'shop' | 'bonuses'
    }

    _setupSubscriptions() {
        this.subscribe('player');
    }

    async onMount() {
        await this._loadPrestigeInfo();

        // Tab switching
        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });

        // Buy upgrade
        this.on('click', '.cf-buy-prestige-upgrade', async (e) => {
            const btn = e.target.closest('.cf-buy-prestige-upgrade');
            if (!btn || btn.disabled) return;
            await this._buyUpgrade(parseInt(btn.dataset.id, 10));
        });

        // Prestige reset
        this.on('click', '.cf-prestige-reset-btn', async (e) => {
            const btn = e.target.closest('.cf-prestige-reset-btn');
            if (!btn || btn.disabled) return;
            await this._performPrestige();
        });
    }

    async _loadPrestigeInfo() {
        const isFirstLoad = !this._prestigeInfo;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.scheduleRender();
        }

        try {
            const response = await api.getPrestigeInfo();
            if (response.success !== false) {
                this._prestigeInfo = response.prestige || response;
                this._upgrades = response.availableUpgrades || response.upgrades || [];
                this._purchasedUpgrades = response.purchasedUpgrades || response.owned || [];
            } else {
                this._error = response.error || 'Failed to load prestige info';
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    async _buyUpgrade(upgradeId) {
        const upgrade = this._upgrades.find(u => u.id === upgradeId);
        if (!upgrade) return;

        const player = this.getState('player') || {};
        const tokens = player.prestigeTokens || 0;

        if (tokens < upgrade.cost) {
            this.emit('notification', { type: 'error', message: 'Not enough prestige tokens' });
            return;
        }

        // Optimistic update
        const oldTokens = tokens;
        const oldUpgrades = [...this._upgrades];
        const oldPurchased = [...this._purchasedUpgrades];

        store.merge('player', { prestigeTokens: tokens - upgrade.cost });
        this._upgrades = this._upgrades.filter(u => u.id !== upgradeId);
        this._purchasedUpgrades.push(upgrade);
        this.scheduleRender();

        try {
            const response = await api.buyPrestigeUpgrade(upgradeId);
            if (response.success) {
                this.emit('notification', {
                    type: 'success',
                    message: `Purchased ${this._getUpgradeInfo(upgrade).name}!`
                });
                await this._loadPrestigeInfo();
            } else {
                throw new Error(response.error || 'Purchase failed');
            }
        } catch (err) {
            // Rollback
            store.merge('player', { prestigeTokens: oldTokens });
            this._upgrades = oldUpgrades;
            this._purchasedUpgrades = oldPurchased;
            this.emit('notification', { type: 'error', message: err.message });
            this.scheduleRender();
        }
    }

    async _performPrestige() {
        const player = this.getState('player') || {};
        const level = player.level || 1;

        if (level < 10) {
            this.emit('notification', { type: 'error', message: 'Must be level 10+ to prestige' });
            return;
        }

        const tokensToEarn = Math.floor(level / 10);
        if (!confirm(`Prestige now to earn ${tokensToEarn} token(s)?\n\nThis will reset your progress but keep your prestige upgrades!`)) {
            return;
        }

        try {
            const response = await api.performPrestige();
            if (response.success) {
                this.emit('notification', {
                    type: 'success',
                    message: `Prestiged! Earned ${tokensToEarn} token(s)!`
                });
                // Reload entire game state
                window.location.reload();
            } else {
                throw new Error(response.error || 'Prestige failed');
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    _getUpgradeInfo(upgrade) {
        const key = upgrade.key || upgrade.upgradeKey || upgrade.type || 'default';
        const info = PRESTIGE_UPGRADES[key] || PRESTIGE_UPGRADES.default;
        return {
            icon: upgrade.icon || info.icon,
            name: upgrade.name || info.name,
            desc: upgrade.description || info.desc
        };
    }

    render() {
        this.className = 'cf-prestige';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadPrestigeInfo() }, 'Retry')
                )
            );
            return;
        }

        const player = this.getState('player') || {};
        const prestigeLevel = player.prestigeLevel || this._prestigeInfo?.level || 0;
        const prestigeTokens = player.prestigeTokens || this._prestigeInfo?.tokens || 0;

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, 'Prestige'),

            // Status card
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
                            h('div', { class: 'text-xs text-muted' }, 'Prestige Level'),
                            h('div', {
                                class: 'font-bold',
                                style: { fontSize: '1.5rem', color: 'var(--color-legendary)' }
                            }, `⭐ ${prestigeLevel}`)
                        ),
                        h('div', {},
                            h('div', { class: 'text-xs text-muted' }, 'Tokens'),
                            h('div', {
                                class: 'font-bold',
                                style: { fontSize: '1.5rem', color: 'var(--color-epic)' }
                            }, `🪙 ${prestigeTokens}`)
                        ),
                        h('div', {},
                            h('div', { class: 'text-xs text-muted' }, 'Upgrades'),
                            h('div', {
                                class: 'font-bold',
                                style: { fontSize: '1.5rem', color: 'var(--color-success)' }
                            }, `✓ ${this._purchasedUpgrades.length}`)
                        )
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
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'shop' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'shop' }
                }, `Shop (${this._upgrades.length})`),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'bonuses' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'bonuses' }
                }, 'Bonuses')
            ),

            // Tab content
            this._activeTab === 'status' && this._renderStatusTab(),
            this._activeTab === 'shop' && this._renderShopTab(prestigeTokens),
            this._activeTab === 'bonuses' && this._renderBonusesTab()
        );
    }

    _renderStatusTab() {
        const player = this.getState('player') || {};
        const level = player.level || 1;
        const canPrestige = level >= 10;
        const tokensToEarn = Math.floor(level / 10);
        const nextMilestone = Math.ceil((level + 1) / 10) * 10;

        return h('div', { class: 'cf-prestige-status' },
            // Next prestige reward
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Next Prestige')
                ),
                h('div', { class: 'cf-card__body text-center' },
                    canPrestige
                        ? h('div', {},
                            h('div', { class: 'text-lg font-bold mb-2', style: { color: 'var(--color-success)' } },
                                `🪙 ${tokensToEarn} Token${tokensToEarn > 1 ? 's' : ''} Available!`
                            ),
                            h('p', { class: 'text-sm text-muted mb-3' },
                                'Reset your progress to claim your prestige tokens.'
                            ),
                            h('button', {
                                class: 'cf-btn cf-btn--primary cf-btn--lg cf-prestige-reset-btn'
                            }, '✨ Prestige Now')
                        )
                        : h('div', {},
                            h('div', { class: 'text-lg font-bold mb-2' },
                                `Level ${level} / 10`
                            ),
                            h('div', { class: 'cf-progress mb-2' },
                                h('div', {
                                    class: 'cf-progress__bar',
                                    style: { width: `${Math.min(100, (level / 10) * 100)}%` }
                                })
                            ),
                            h('p', { class: 'text-sm text-muted' },
                                `Reach level 10 to prestige for your first token!`
                            )
                        )
                )
            ),

            // What you keep
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'What You Keep')
                ),
                h('div', { class: 'cf-card__body' },
                    h('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } },
                        h('li', { class: 'text-sm mb-1' }, '✅ Prestige tokens & upgrades'),
                        h('li', { class: 'text-sm mb-1' }, '✅ Achievements'),
                        h('li', { class: 'text-sm mb-1' }, '✅ Strain discoveries'),
                        h('li', { class: 'text-sm mb-1' }, '✅ Reputation tiers')
                    )
                )
            ),

            // What resets
            h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'What Resets')
                ),
                h('div', { class: 'cf-card__body' },
                    h('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } },
                        h('li', { class: 'text-sm mb-1 text-muted' }, '❌ Cash & inventory'),
                        h('li', { class: 'text-sm mb-1 text-muted' }, '❌ Level & XP'),
                        h('li', { class: 'text-sm mb-1 text-muted' }, '❌ Equipment & facilities'),
                        h('li', { class: 'text-sm mb-1 text-muted' }, '❌ Workers')
                    )
                )
            )
        );
    }

    _renderShopTab(tokens) {
        if (this._upgrades.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'Shop Empty'),
                h('p', { class: 'cf-empty__description' }, 'All upgrades purchased! Check back after prestiging.')
            );
        }

        // Sort by cost
        const sortedUpgrades = [...this._upgrades].sort((a, b) => a.cost - b.cost);

        return h('div', { class: 'cf-prestige-shop' },
            h('p', { class: 'text-sm text-muted mb-3' },
                `You have 🪙 ${tokens} token${tokens !== 1 ? 's' : ''} to spend`
            ),
            ...sortedUpgrades.map(upgrade => this._renderUpgradeCard(upgrade, tokens))
        );
    }

    _renderUpgradeCard(upgrade, tokens) {
        const info = this._getUpgradeInfo(upgrade);
        const canAfford = tokens >= upgrade.cost;
        const effectValue = upgrade.effectValue || upgrade.value || 0;
        const effectDisplay = upgrade.effectType?.includes('multiplier') || upgrade.effectType?.includes('percent')
            ? `+${Math.round(effectValue * 100)}%`
            : upgrade.effectType?.includes('flat')
                ? `+${effectValue.toLocaleString()}`
                : `+${effectValue}`;

        return h('div', {
            class: 'cf-card mb-2',
            style: { opacity: canAfford ? 1 : 0.6 }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                    h('div', {
                        style: {
                            fontSize: '1.5rem',
                            width: '40px',
                            textAlign: 'center'
                        }
                    }, info.icon),
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' }, info.name),
                        h('div', { class: 'text-xs text-muted' }, info.desc),
                        effectValue > 0 && h('div', {
                            class: 'text-xs mt-1',
                            style: { color: 'var(--color-success)' }
                        }, effectDisplay)
                    ),
                    h('button', {
                        class: `cf-btn cf-btn--sm cf-buy-prestige-upgrade ${canAfford ? 'cf-btn--primary' : ''}`,
                        dataset: { id: upgrade.id?.toString() },
                        disabled: !canAfford
                    }, `🪙 ${upgrade.cost}`)
                )
            )
        );
    }

    _renderBonusesTab() {
        if (this._purchasedUpgrades.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Bonuses Yet'),
                h('p', { class: 'cf-empty__description' }, 'Purchase upgrades from the shop to gain permanent bonuses!')
            );
        }

        // Group by type
        const bonuses = this._purchasedUpgrades.map(u => ({
            ...u,
            info: this._getUpgradeInfo(u)
        }));

        return h('div', { class: 'cf-prestige-bonuses' },
            h('p', { class: 'text-sm text-muted mb-3' },
                'Your permanent bonuses that persist through prestiges:'
            ),
            ...bonuses.map(bonus => {
                const effectValue = bonus.effectValue || bonus.value || 0;
                const effectDisplay = bonus.effectType?.includes('multiplier') || bonus.effectType?.includes('percent')
                    ? `+${Math.round(effectValue * 100)}%`
                    : `+${effectValue.toLocaleString()}`;

                return h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                            h('div', { style: { fontSize: '1.25rem' } }, bonus.info.icon),
                            h('div', { style: { flex: 1 } },
                                h('div', { class: 'font-semibold' }, bonus.info.name),
                                h('div', { class: 'text-xs text-muted' }, bonus.info.desc)
                            ),
                            h('div', {
                                class: 'font-bold',
                                style: { color: 'var(--color-success)' }
                            }, effectDisplay)
                        )
                    )
                );
            })
        );
    }
}

registerComponent('cf-prestige', CFPrestige);
export default CFPrestige;
