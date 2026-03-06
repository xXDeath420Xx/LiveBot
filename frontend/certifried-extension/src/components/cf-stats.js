/**
 * CertiFried Extension - Statistics Dashboard Component
 * Shows lifetime player statistics and progress
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency } from '../utils/format.js';
import { api } from '../api/client.js';

class CFStats extends CFBaseComponent {
    constructor() {
        super();
        this._stats = null;
        this._isLoading = true;
    }

    onMount() {
        this._loadStats();
    }

    async _loadStats() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = !this._stats;

        if (isFirstLoad) {
            this._isLoading = true;
            this.render();
        }

        try {
            const data = await api.getPlayerStats();
            this._stats = data.stats;

        } catch (error) {
            console.error('Failed to load stats:', error);
        } finally {
            this._isLoading = false;
            this.scheduleRender();
        }
    }

    render() {
        this.className = 'cf-stats cf-section';

        if (this._isLoading) {
            this.setContent(
                h('div', { class: 'cf-loading' },
                    h('div', { class: 'cf-spinner' })
                )
            );
            return;
        }

        if (!this._stats) {
            this.setContent(
                h('div', { class: 'cf-empty' },
                    h('p', {}, 'Failed to load statistics')
                )
            );
            return;
        }

        // Provide defaults for all stat fields to prevent crashes on partial API responses
        const s = {
            totalHarvests: 0, totalPlantsGrown: 0, highestQualityGrown: 0,
            totalCashEarned: 0, totalCashSpent: 0, netProfit: 0,
            strainsDiscovered: 0, totalStrains: 0, collectionProgress: 0, uniqueStrainsInInventory: 0,
            totalBreedingAttempts: 0, totalBreedingSuccesses: 0, breedingSuccessRate: 0,
            totalXpEarned: 0, achievementsUnlocked: 0, totalAchievements: 0, questsCompleted: 0,
            totalLoginDays: 0, highestStreak: 0, totalPrestigeResets: 0,
            totalTradesCompleted: 0, totalInventoryItems: 0, totalPlaytimeHours: 0,
            ...this._stats
        };

        this.setContent(
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Statistics')
            ),

            // Stats grid
            h('div', { class: 'cf-stats__grid' },
                // Growing Stats
                this._renderStatGroup('Growing', [
                    { label: 'Total Harvests', value: s.totalHarvests.toLocaleString(), icon: '🌿' },
                    { label: 'Plants Grown', value: s.totalPlantsGrown.toLocaleString(), icon: '🌱' },
                    { label: 'Best Quality', value: `${s.highestQualityGrown}%`, icon: '⭐' }
                ]),

                // Economy Stats
                this._renderStatGroup('Economy', [
                    { label: 'Cash Earned', value: formatCurrency(s.totalCashEarned, true), icon: '💰' },
                    { label: 'Cash Spent', value: formatCurrency(s.totalCashSpent, true), icon: '💸' },
                    { label: 'Net Profit', value: formatCurrency(s.netProfit, true), icon: s.netProfit >= 0 ? '📈' : '📉' }
                ]),

                // Collection Stats
                this._renderStatGroup('Collection', [
                    { label: 'Strains Discovered', value: `${s.strainsDiscovered}/${s.totalStrains}`, icon: '📖' },
                    { label: 'Collection Progress', value: `${s.collectionProgress}%`, icon: '🏆', progress: s.collectionProgress },
                    { label: 'In Inventory', value: `${s.uniqueStrainsInInventory} types`, icon: '📦' }
                ]),

                // Breeding Stats
                this._renderStatGroup('Breeding', [
                    { label: 'Breeding Attempts', value: s.totalBreedingAttempts.toLocaleString(), icon: '🧬' },
                    { label: 'Successes', value: s.totalBreedingSuccesses.toLocaleString(), icon: '✅' },
                    { label: 'Success Rate', value: `${s.breedingSuccessRate}%`, icon: '📊', progress: s.breedingSuccessRate }
                ]),

                // Progress Stats
                this._renderStatGroup('Progress', [
                    { label: 'Total XP Earned', value: s.totalXpEarned.toLocaleString(), icon: '⚡' },
                    { label: 'Achievements', value: `${s.achievementsUnlocked}/${s.totalAchievements}`, icon: '🏅' },
                    { label: 'Quests Completed', value: s.questsCompleted.toLocaleString(), icon: '📋' }
                ]),

                // Engagement Stats
                this._renderStatGroup('Engagement', [
                    { label: 'Login Days', value: s.totalLoginDays.toLocaleString(), icon: '📅' },
                    { label: 'Best Streak', value: `${s.highestStreak} days`, icon: '🔥' },
                    { label: 'Prestige Resets', value: s.totalPrestigeResets.toLocaleString(), icon: '♻️' }
                ]),

                // Trading Stats
                this._renderStatGroup('Trading', [
                    { label: 'Trades Completed', value: s.totalTradesCompleted.toLocaleString(), icon: '🤝' },
                    { label: 'Items in Inventory', value: s.totalInventoryItems.toLocaleString(), icon: '📦' },
                    { label: 'Playtime', value: `${s.totalPlaytimeHours}h`, icon: '⏱️' }
                ])
            )
        );
    }

    _renderStatGroup(title, stats) {
        return h('div', { class: 'cf-stats__group' },
            h('h3', { class: 'cf-stats__group-title' }, title),
            h('div', { class: 'cf-stats__group-items' },
                ...stats.map(stat => this._renderStatItem(stat))
            )
        );
    }

    _renderStatItem(stat) {
        return h('div', { class: 'cf-stats__item' },
            h('span', { class: 'cf-stats__item-icon' }, stat.icon),
            h('div', { class: 'cf-stats__item-content' },
                h('span', { class: 'cf-stats__item-value' }, stat.value),
                h('span', { class: 'cf-stats__item-label' }, stat.label),
                stat.progress !== undefined && h('div', { class: 'cf-stats__progress' },
                    h('div', {
                        class: 'cf-stats__progress-bar',
                        style: { width: `${Math.min(100, stat.progress)}%` }
                    })
                )
            )
        );
    }
}

registerComponent('cf-stats', CFStats);
export default CFStats;
