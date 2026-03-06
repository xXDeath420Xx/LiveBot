/**
 * CertiFried Extension - AI Assistant Component
 * Game advisor and automation suggestions
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency } from '../utils/format.js';
import { store } from '../state/store.js';
import { api } from '../api/client.js';

class CFAIAssistant extends CFBaseComponent {
    constructor() {
        super();
        this._suggestions = [];
        this._activeTab = 'suggestions'; // 'suggestions' | 'automation' | 'analysis'
        this._automationSettings = {
            autoHarvest: false,
            autoReplant: false,
            autoSell: false,
            autoBreed: false,
            autoClaim: false
        };
    }

    _setupSubscriptions() {
        this.subscribe('player');
        this.subscribe('garden');
        this.subscribe('inventory');
        this.subscribe('market');
        this.subscribe('settings');
    }

    onMount() {
        this._generateSuggestions();
        this._loadAutomationSettings();

        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });

        this.on('click', '.cf-suggestion-action', (e) => {
            const btn = e.target.closest('.cf-suggestion-action');
            if (!btn) return;
            this._executeSuggestion(btn.dataset.action);
        });

        this.on('change', '.cf-automation-toggle', async (e) => {
            const toggle = e.target;
            const setting = toggle.dataset.setting;
            this._automationSettings[setting] = toggle.checked;
            await this._saveAutomationSettings(setting, toggle.checked);
            this.render();
        });

        this.on('click', '.cf-dismiss-suggestion', (e) => {
            const btn = e.target.closest('.cf-dismiss-suggestion');
            if (!btn) return;
            const idx = parseInt(btn.dataset.index, 10);
            this._suggestions.splice(idx, 1);
            this.render();
        });

        // Refresh suggestions periodically
        this._refreshInterval = setInterval(() => {
            this._generateSuggestions();
            this.scheduleRender();
        }, 30000);
    }

    onUnmount() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
        }
    }

    _loadAutomationSettings() {
        // Read from shared store (single source of truth)
        const settings = store.get('settings') || {};
        this._automationSettings = {
            autoHarvest: settings.autoHarvest || false,
            autoReplant: settings.autoReplant || false,
            autoBuySeeds: settings.autoBuySeeds || false,
            autoSell: settings.autoSell || false,
            autoBreed: settings.autoBreed || false,
            autoClaim: settings.autoCollect || false
        };
    }

    async _saveAutomationSettings(key, value) {
        // Map autoClaim back to autoCollect for server
        const serverKey = key === 'autoClaim' ? 'autoCollect' : key;

        // Update shared store
        store.set(`settings.${serverKey}`, value);

        // Sync to server
        try {
            const result = await api.updateSettings({ [serverKey]: value });
            if (result.settings) {
                store.loadServerSettings(result.settings);
            }
        } catch (e) {
            console.warn('[AIAssistant] Settings sync failed:', e);
        }

        // Persist to localStorage backup
        store._persistSettings();
    }

    _generateSuggestions() {
        const suggestions = [];
        const player = this.getState('player') || {};
        const garden = this.getState('garden') || {};
        const inventory = this.getState('inventory') || {};
        const market = this.getState('market') || {};

        // Check for harvestable plants
        const plots = garden.plots || [];
        const readyToHarvest = plots.filter(p => p.status === 'ready' || p.growthPercent >= 100);
        if (readyToHarvest.length > 0) {
            suggestions.push({
                icon: '🌿',
                priority: 'high',
                title: `${readyToHarvest.length} plant${readyToHarvest.length > 1 ? 's' : ''} ready!`,
                desc: 'Harvest now to collect your yield',
                action: 'harvest',
                actionLabel: 'Harvest All'
            });
        }

        // Check empty plots
        const emptyPlots = plots.filter(p => !p.strainId && p.status !== 'growing');
        if (emptyPlots.length > 0 && plots.length > 0) {
            suggestions.push({
                icon: '🌱',
                priority: 'medium',
                title: `${emptyPlots.length} empty plot${emptyPlots.length > 1 ? 's' : ''}`,
                desc: 'Plant seeds to maximize production',
                action: 'plant',
                actionLabel: 'Go to Garden'
            });
        }

        // Check inventory capacity
        const items = inventory.items || [];
        const totalItems = items.reduce((sum, i) => sum + (i.quantity || 0), 0);
        const maxInventory = player.maxInventory || 100;
        if (totalItems > maxInventory * 0.8) {
            suggestions.push({
                icon: '📦',
                priority: 'high',
                title: 'Inventory almost full',
                desc: `${totalItems}/${maxInventory} slots used - sell or store items`,
                action: 'sell',
                actionLabel: 'Go to Market'
            });
        }

        // Check cash for upgrades
        const cash = player.currency || player.cash || 0;
        if (cash > 50000 && (player.level || 1) < 10) {
            suggestions.push({
                icon: '⬆️',
                priority: 'medium',
                title: 'Upgrade opportunity',
                desc: 'You have cash available for facility upgrades',
                action: 'facility',
                actionLabel: 'View Facility'
            });
        }

        // Check for unclaimed daily rewards
        const lastDaily = player.lastDailyReward;
        const now = new Date();
        if (!lastDaily || (now - new Date(lastDaily)) > 24 * 60 * 60 * 1000) {
            suggestions.push({
                icon: '🎁',
                priority: 'high',
                title: 'Daily reward available!',
                desc: 'Claim your daily bonus',
                action: 'daily',
                actionLabel: 'Claim Now'
            });
        }

        // Check heat level
        const heat = player.heat || 0;
        if (heat > 50) {
            suggestions.push({
                icon: '🔥',
                priority: heat > 75 ? 'high' : 'medium',
                title: 'Heat level warning',
                desc: `${heat}% heat - risk of DEA raid`,
                action: 'vault',
                actionLabel: 'Protect Assets'
            });
        }

        // Market opportunity
        const prices = market.prices || [];
        const highPriceStrains = prices.filter(p => (p.changePercent || 0) > 10);
        if (highPriceStrains.length > 0) {
            suggestions.push({
                icon: '📈',
                priority: 'low',
                title: 'Market opportunity',
                desc: `${highPriceStrains.length} strain${highPriceStrains.length > 1 ? 's' : ''} with rising prices`,
                action: 'market',
                actionLabel: 'View Market'
            });
        }

        // Prestige available
        if ((player.level || 1) >= 10 && (player.prestigeLevel || 0) < 5) {
            suggestions.push({
                icon: '⭐',
                priority: 'low',
                title: 'Prestige available',
                desc: 'Reset for permanent bonuses',
                action: 'prestige',
                actionLabel: 'View Prestige'
            });
        }

        // Sort by priority
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

        this._suggestions = suggestions.slice(0, 5); // Max 5 suggestions
    }

    _executeSuggestion(action) {
        const navActions = {
            harvest: 'garden',
            plant: 'garden',
            sell: 'market',
            facility: 'more',
            daily: 'more',
            vault: 'more',
            market: 'market',
            prestige: 'more'
        };

        const nav = navActions[action];
        if (nav) {
            this.emit('navigate', { view: nav, subview: action === 'daily' ? 'daily-rewards' : action });
        }
    }

    render() {
        this.className = 'cf-ai-assistant';

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, '🤖 AI Assistant'),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'suggestions' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'suggestions' }
                }, `Tips (${this._suggestions.length})`),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'automation' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'automation' }
                }, 'Automation'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'analysis' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'analysis' }
                }, 'Analysis')
            ),

            this._activeTab === 'suggestions' && this._renderSuggestionsTab(),
            this._activeTab === 'automation' && this._renderAutomationTab(),
            this._activeTab === 'analysis' && this._renderAnalysisTab()
        );
    }

    _renderSuggestionsTab() {
        if (this._suggestions.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'All Caught Up!'),
                h('p', { class: 'cf-empty__description' }, 'No suggestions right now. Keep growing!')
            );
        }

        return h('div', { class: 'cf-suggestions-list' },
            ...this._suggestions.map((suggestion, idx) => {
                const priorityColors = {
                    high: 'var(--color-danger)',
                    medium: 'var(--color-warning)',
                    low: 'var(--color-success)'
                };

                return h('div', {
                    class: 'cf-card mb-2',
                    style: { borderLeft: `3px solid ${priorityColors[suggestion.priority]}` }
                },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)' } },
                            h('div', { style: { fontSize: '1.5rem' } }, suggestion.icon),
                            h('div', { style: { flex: 1 } },
                                h('div', { class: 'font-semibold' }, suggestion.title),
                                h('div', { class: 'text-xs text-muted' }, suggestion.desc)
                            ),
                            h('div', { style: { display: 'flex', gap: 'var(--space-1)', flexDirection: 'column' } },
                                suggestion.action && h('button', {
                                    class: 'cf-btn cf-btn--sm cf-btn--primary cf-suggestion-action',
                                    dataset: { action: suggestion.action }
                                }, suggestion.actionLabel),
                                h('button', {
                                    class: 'cf-btn cf-btn--sm cf-btn--ghost cf-dismiss-suggestion',
                                    dataset: { index: idx.toString() },
                                    style: { fontSize: '0.7rem' }
                                }, 'Dismiss')
                            )
                        )
                    )
                );
            })
        );
    }

    _renderAutomationTab() {
        // Refresh from store on each render to pick up external changes
        this._loadAutomationSettings();

        const automations = [
            { key: 'autoHarvest', icon: '🌿', name: 'Auto-Harvest', desc: 'Automatically harvest ready plants' },
            { key: 'autoReplant', icon: '🌱', name: 'Auto-Replant', desc: 'Replant after harvesting' },
            { key: 'autoBuySeeds', icon: '🛒', name: 'Auto-Buy Seeds', desc: 'Buy seeds when supply runs low' },
            { key: 'autoSell', icon: '💰', name: 'Auto-Sell', desc: 'Sell items via NPC market' },
            { key: 'autoBreed', icon: '🧬', name: 'Auto-Breed', desc: 'Start breeding when slots available' },
            { key: 'autoClaim', icon: '🎁', name: 'Auto-Claim', desc: 'Claim rewards automatically' }
        ];

        return h('div', { class: 'cf-automation-settings' },
            h('p', { class: 'text-sm text-muted mb-3' },
                'Configure automation to streamline your operation.'
            ),

            // Worker requirement notice
            h('div', {
                class: 'cf-card mb-3',
                style: { background: 'var(--bg-tertiary)' }
            },
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' } },
                        h('span', {}, '👷'),
                        h('span', { class: 'text-sm' },
                            'Most automation requires workers. Hire workers from the Workers menu.'
                        )
                    )
                )
            ),

            ...automations.map(auto =>
                h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                            h('span', { style: { fontSize: '1.25rem' } }, auto.icon),
                            h('div', { style: { flex: 1 } },
                                h('div', { class: 'font-semibold' }, auto.name),
                                h('div', { class: 'text-xs text-muted' }, auto.desc)
                            ),
                            h('label', { class: 'cf-toggle' },
                                h('input', {
                                    type: 'checkbox',
                                    class: 'cf-automation-toggle',
                                    dataset: { setting: auto.key },
                                    checked: this._automationSettings[auto.key]
                                }),
                                h('span', { class: 'cf-toggle__slider' })
                            )
                        )
                    )
                )
            )
        );
    }

    _renderAnalysisTab() {
        const player = this.getState('player') || {};
        const inventory = this.getState('inventory') || {};
        const garden = this.getState('garden') || {};
        const bonuses = this.getState('botBonuses') || {};

        // Fetch detailed stats in background on first view
        if (!this._statsLoaded) {
            this._statsLoaded = true;
            api.getPlayerStats().then(result => {
                if (result?.stats) {
                    this._playerStats = result.stats;
                    this.scheduleRender();
                }
            }).catch(() => {});
        }
        const stats = this._playerStats || {};

        // Calculate inventory value
        const items = inventory.items || [];
        const totalValue = items.reduce((sum, i) => {
            const price = i.price || i.basePrice || 100;
            return sum + (price * (i.quantity || 0) * ((i.quality || 50) / 50));
        }, 0);

        const avgQuality = items.length > 0
            ? Math.round(items.reduce((sum, i) => sum + (i.quality || 50), 0) / items.length)
            : 0;

        // Calculate earnings/hour from lifetime stats + account age
        const lifetimeEarnings = player.lifetimeEarnings || parseFloat(stats.totalCashEarned) || 0;
        const firstLogin = stats.firstLoginAt ? new Date(stats.firstLoginAt) : null;
        const accountHours = firstLogin ? Math.max(1, (Date.now() - firstLogin.getTime()) / 3600000) : 1;
        const earningsPerHour = lifetimeEarnings > 0 ? lifetimeEarnings / accountHours : 0;

        // Garden utilization
        const plots = garden.plots || [];
        const maxPlots = player.maxPlots || 2;
        const activePlots = plots.filter(p => p.strainId || p.status === 'growing' || p.status === 'ready').length;
        const gardenUtil = maxPlots > 0 ? Math.round((activePlots / maxPlots) * 100) : 0;

        // Collection progress
        const collectionPct = stats.collectionProgress || 0;

        // Efficiency grade based on multiple factors
        const grade = this._getEfficiencyGrade(player, avgQuality, gardenUtil, collectionPct, bonuses);

        return h('div', { class: 'cf-analysis' },
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Performance Metrics')
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
                            h('div', { class: 'text-xs text-muted' }, 'Inventory Value'),
                            h('div', { class: 'font-bold', style: { color: 'var(--color-success)' } },
                                formatCurrency(totalValue)
                            )
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Avg Quality'),
                            h('div', { class: 'font-bold' }, `${avgQuality}%`)
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Lifetime Earned'),
                            h('div', { class: 'font-bold' }, formatCurrency(lifetimeEarnings))
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Efficiency'),
                            h('div', { class: 'font-bold' }, grade)
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Garden Use'),
                            h('div', { class: 'font-bold' }, `${gardenUtil}%`)
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Collection'),
                            h('div', { class: 'font-bold' }, `${collectionPct}%`)
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Total Harvests'),
                            h('div', { class: 'font-bold' }, (stats.totalHarvests || 0).toLocaleString())
                        ),
                        h('div', { class: 'text-center' },
                            h('div', { class: 'text-xs text-muted' }, 'Net Profit'),
                            h('div', { class: 'font-bold', style: { color: (stats.netProfit || 0) >= 0 ? 'var(--color-success)' : 'var(--color-danger)' } },
                                formatCurrency(stats.netProfit || 0)
                            )
                        )
                    )
                )
            ),

            h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Recommendations')
                ),
                h('div', { class: 'cf-card__body' },
                    this._getRecommendations(stats).map(rec =>
                        h('div', {
                            class: 'text-sm mb-2',
                            style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)' }
                        },
                            h('span', {}, rec.icon),
                            h('span', {}, rec.text)
                        )
                    )
                )
            )
        );
    }

    _getEfficiencyGrade(player, avgQuality, gardenUtil, collectionPct, bonuses) {
        const level = player.level || 1;
        const maxLevel = 100;

        // Multi-factor score (each 0-1 range)
        const levelScore = Math.min(1, level / maxLevel);          // 20% - level progression
        const qualityScore = (avgQuality || 0) / 100;             // 25% - average quality
        const gardenScore = (gardenUtil || 0) / 100;              // 20% - garden utilization
        const collectionScore = (collectionPct || 0) / 100;       // 15% - strain collection
        const bonusScore = Math.min(1,                            // 20% - active bonuses
            ((bonuses.growthSpeedBonus || 0) +
             (bonuses.yieldBonus || 0) +
             (bonuses.xpBonus || 0) +
             (bonuses.sellPriceBonus || 0)) / 100
        );

        const score = (levelScore * 0.20) +
                       (qualityScore * 0.25) +
                       (gardenScore * 0.20) +
                       (collectionScore * 0.15) +
                       (bonusScore * 0.20);

        if (score >= 0.85) return 'S';
        if (score >= 0.70) return 'A';
        if (score >= 0.55) return 'B';
        if (score >= 0.40) return 'C';
        return 'D';
    }

    _getRecommendations(stats = {}) {
        const recs = [];
        const player = this.getState('player') || {};
        const garden = this.getState('garden') || {};
        const inventory = this.getState('inventory') || {};
        const settings = store.get('settings') || {};
        const bonuses = this.getState('botBonuses') || {};
        const level = player.level || 1;
        const cash = player.cash || player.currency || 0;
        const plots = garden.plots || [];
        const maxPlots = player.maxPlots || 2;
        const activePlots = plots.filter(p => p.strainId || p.status === 'growing' || p.status === 'ready').length;
        const items = inventory.items || [];

        // === Early game (1-10) ===
        if (level < 5) {
            recs.push({ icon: '📚', text: 'Focus on completing quests for fast early XP' });
        }
        if (level >= 5 && level < 15) {
            recs.push({ icon: '🧬', text: 'Start breeding strains to unlock rarer varieties' });
        }

        // === Garden utilization ===
        if (activePlots < maxPlots && maxPlots > 0) {
            const empty = maxPlots - activePlots;
            recs.push({ icon: '🌱', text: `${empty} garden slot${empty > 1 ? 's' : ''} idle — keep all plots planted for max output` });
        }

        // === Automation not enabled ===
        if (!settings.autoHarvest && level >= 5) {
            recs.push({ icon: '🤖', text: 'Enable Auto-Harvest to avoid plants withering while offline' });
        }
        if (!settings.autoReplant && level >= 10) {
            recs.push({ icon: '🔄', text: 'Enable Auto-Replant to keep garden running 24/7' });
        }

        // === Spending vs earning ===
        const netProfit = stats.netProfit || 0;
        if (netProfit < 0) {
            recs.push({ icon: '📊', text: 'Spending exceeds earnings — focus on growing and selling before upgrades' });
        }

        // === Quality optimization ===
        const avgQuality = items.length > 0
            ? items.reduce((sum, i) => sum + (i.quality || 50), 0) / items.length
            : 50;
        if (avgQuality < 60 && level >= 10) {
            recs.push({ icon: '💎', text: 'Invest in quality-boosting skills and equipment for higher profits' });
        }

        // === Collection ===
        const collectionPct = stats.collectionProgress || 0;
        if (collectionPct < 50 && level >= 15) {
            recs.push({ icon: '🔬', text: `Only ${collectionPct}% strains discovered — breed more to expand your collection` });
        }

        // === High-level player tips (20+) ===
        if (level >= 20 && (player.prestigeLevel || 0) === 0) {
            recs.push({ icon: '⭐', text: 'Consider your first Prestige reset for permanent bonus multipliers' });
        }

        if (level >= 30 && cash > 500000) {
            recs.push({ icon: '🏪', text: 'Open a Dispensary to earn passive income from NPC customers' });
        }

        if (level >= 25 && !settings.autoSell) {
            recs.push({ icon: '💰', text: 'Enable Auto-Sell to convert harvests into cash while you\'re away' });
        }

        // === Bonus optimization ===
        const totalBonus = (bonuses.growthSpeedBonus || 0) + (bonuses.yieldBonus || 0) + (bonuses.sellPriceBonus || 0);
        if (totalBonus < 20 && level >= 15) {
            recs.push({ icon: '📈', text: 'Unlock more skills, equipment, and research for stronger bonuses' });
        }

        // === Very high level tips (50+) ===
        if (level >= 50) {
            if ((stats.breedingSuccessRate || 0) > 0 && stats.breedingSuccessRate < 60) {
                recs.push({ icon: '🧪', text: `Breeding success rate is ${stats.breedingSuccessRate}% — upgrade breeding skills for better odds` });
            }

            if (collectionPct >= 80) {
                recs.push({ icon: '🏆', text: 'Near-complete collection! Chase the last strains through targeted breeding' });
            }
        }

        // === Heat warning ===
        const heat = store.get('heat.current') || 0;
        if (heat > 50) {
            recs.push({ icon: '🔥', text: `Heat at ${heat}% — use the vault and lay low to avoid raids` });
        }

        // === Fallback: something positive for maxed players ===
        if (recs.length === 0) {
            recs.push({ icon: '👑', text: 'Your operation is running at peak efficiency — well played!' });
            if (level >= 50) {
                recs.push({ icon: '🌍', text: 'Compete in Tournaments and claim Territories to dominate the leaderboard' });
            }
        }

        return recs.slice(0, 5);
    }
}

registerComponent('cf-ai-assistant', CFAIAssistant);
export default CFAIAssistant;
