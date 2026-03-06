/**
 * CertiFried Extension - Dashboard Component
 * Quick overview of all game systems and progress
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatNumber, formatTimeRemaining } from '../utils/format.js';
import { store } from '../state/store.js';
import { api } from '../api/client.js';

class CFDashboard extends CFBaseComponent {
    constructor() {
        super();
        this._loading = true;
        this._stats = {};
        this._activeTimers = [];
        this._notifications = [];
        this._refreshInterval = null;
    }

    _setupSubscriptions() {
        this.subscribe('player');
        this.subscribe('garden');
    }

    async onMount() {
        await this._loadDashboardData();

        // Refresh every 30 seconds
        this._refreshInterval = setInterval(() => {
            this._loadDashboardData();
        }, 30000);

        // Quick action clicks
        this.on('click', '.cf-quick-action', (e) => {
            const action = e.target.closest('.cf-quick-action');
            if (!action) return;
            const target = action.dataset.target;
            const subview = action.dataset.subview;
            if (target) {
                // Navigate to the target view (and optional subview for More menu items)
                this.emit('navigate', { view: target, subview: subview || null });
            }
        });

        // Dismiss notification
        this.on('click', '.cf-dismiss-notification', (e) => {
            const btn = e.target.closest('.cf-dismiss-notification');
            const idx = parseInt(btn.dataset.idx, 10);
            this._notifications.splice(idx, 1);
            this.render();
        });
    }

    onUnmount() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
        }
    }

    async _loadDashboardData() {
        const isFirstLoad = !this._stats.loaded;

        if (isFirstLoad) {
            this._loading = true;
            this.render();
        }

        try {
            // Gather stats from various sources
            const [gameState] = await Promise.all([
                api.getGameState().catch(() => ({}))
            ]);

            this._stats = {
                loaded: true,
                player: gameState.player || {},
                garden: gameState.garden || {},
                breeding: gameState.breeding || {},
                workers: gameState.workers || {},
                quests: gameState.quests || {},
                events: gameState.events || []
            };

            // Build active timers list
            this._activeTimers = this._gatherActiveTimers();

            // Build notifications
            this._notifications = this._gatherNotifications();

        } catch (err) {
            console.error('[CFDashboard] Load error:', err);
        }

        this._loading = false;
        this.scheduleRender();
    }

    _gatherActiveTimers() {
        const timers = [];
        const now = Date.now();

        // Garden timers
        const plots = this.getState('garden.plots') || [];
        plots.forEach((plot, idx) => {
            if (plot.plantedAt && plot.harvestAt) {
                const harvestTime = typeof plot.harvestAt === 'number' ? plot.harvestAt : new Date(plot.harvestAt).getTime();
                if (harvestTime > now) {
                    timers.push({
                        type: 'garden',
                        icon: '🌱',
                        label: `Slot ${idx + 1}: ${plot.strainName || 'Growing'}`,
                        endsAt: harvestTime
                    });
                }
            }
        });

        // Breeding timer
        const breeding = this.getState('breeding.inProgress');
        if (breeding?.completeAt) {
            const completeTime = typeof breeding.completeAt === 'number' ? breeding.completeAt : new Date(breeding.completeAt).getTime();
            if (completeTime > now) {
                timers.push({
                    type: 'breeding',
                    icon: '🧬',
                    label: 'Breeding',
                    endsAt: completeTime
                });
            }
        }

        // Sort by ending soonest
        return timers.sort((a, b) => a.endsAt - b.endsAt).slice(0, 5);
    }

    _gatherNotifications() {
        const notifications = [];
        const player = this.getState('player') || {};

        // Daily reward available
        if (player.dailyRewardAvailable) {
            notifications.push({
                type: 'info',
                icon: '🎁',
                message: 'Daily reward available!',
                action: 'daily-rewards'
            });
        }

        // Quest completed
        const quests = this._stats.quests?.active || [];
        const completed = quests.filter(q => q.isComplete && !q.isClaimed);
        if (completed.length > 0) {
            notifications.push({
                type: 'success',
                icon: '✅',
                message: `${completed.length} quest${completed.length > 1 ? 's' : ''} ready to claim!`,
                action: 'quests'
            });
        }

        return notifications;
    }

    render() {
        this.className = 'cf-dashboard';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        const player = this.getState('player') || {};
        const plots = this.getState('garden.plots') || [];
        const readyToHarvest = plots.filter(p => p.harvestAt && Date.now() >= (typeof p.harvestAt === 'number' ? p.harvestAt : new Date(p.harvestAt).getTime())).length;

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, '📊 Dashboard'),

            // Notifications
            this._notifications.length > 0 && h('div', { class: 'cf-dashboard__notifications mb-3' },
                ...this._notifications.map((notif, idx) =>
                    h('div', {
                        class: 'cf-card mb-2',
                        style: { borderLeft: `3px solid ${this._getNotifColor(notif.type)}` }
                    },
                        h('div', {
                            class: 'cf-card__body',
                            style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }
                        },
                            h('span', {}, notif.icon),
                            h('span', { class: 'text-sm', style: { flex: 1 } }, notif.message),
                            notif.action && h('button', {
                                class: 'cf-btn cf-btn--sm cf-btn--primary cf-quick-action',
                                dataset: { target: notif.action }
                            }, 'Go'),
                            h('button', {
                                class: 'cf-btn cf-btn--ghost cf-btn--sm cf-dismiss-notification',
                                dataset: { idx: idx.toString() }
                            }, '✕')
                        )
                    )
                )
            ),

            // Quick stats
            h('div', {
                class: 'cf-dashboard__stats mb-3',
                style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-2)' }
            },
                this._renderStatCard('Cash', formatCurrency(player.currency || 0, true), '💰', 'var(--color-success)'),
                this._renderStatCard('Level', `${player.level || 1}`, '⭐', 'var(--color-warning)'),
                this._renderStatCard('XP', formatNumber(player.xp || 0), '✨', 'var(--color-primary)')
            ),

            // Garden status
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, '🌿 Garden Status')
                ),
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'flex', justifyContent: 'space-around', textAlign: 'center' } },
                        h('div', {},
                            h('div', { class: 'text-lg font-bold' }, plots.length),
                            h('div', { class: 'text-xs text-muted' }, 'Active Plots')
                        ),
                        h('div', {},
                            h('div', {
                                class: 'text-lg font-bold',
                                style: { color: readyToHarvest > 0 ? 'var(--color-success)' : 'inherit' }
                            }, readyToHarvest),
                            h('div', { class: 'text-xs text-muted' }, 'Ready')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold' }, player.maxPlots || 2),
                            h('div', { class: 'text-xs text-muted' }, 'Max Slots')
                        )
                    ),
                    readyToHarvest > 0 && h('button', {
                        class: 'cf-btn cf-btn--success cf-quick-action mt-3',
                        dataset: { target: 'garden' },
                        style: { width: '100%' }
                    }, `Harvest ${readyToHarvest} Ready!`)
                )
            ),

            // Active timers
            this._activeTimers.length > 0 && h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, '⏱️ Active Timers')
                ),
                h('div', { class: 'cf-card__body' },
                    ...this._activeTimers.map(timer => {
                        const remaining = timer.endsAt - Date.now();
                        return h('div', {
                            style: {
                                display: 'flex',
                                justifyContent: 'space-between',
                                padding: 'var(--space-1) 0',
                                borderBottom: '1px solid var(--border-primary)'
                            }
                        },
                            h('span', { class: 'text-sm' },
                                h('span', { style: { marginRight: 'var(--space-1)' } }, timer.icon),
                                timer.label
                            ),
                            h('span', {
                                class: 'text-sm font-mono',
                                style: { color: remaining < 60000 ? 'var(--color-success)' : 'var(--text-muted)' }
                            }, formatTimeRemaining(remaining))
                        );
                    })
                )
            ),

            // Quick actions grid
            h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, '⚡ Quick Actions')
                ),
                h('div', { class: 'cf-card__body' },
                    h('div', {
                        style: {
                            display: 'grid',
                            gridTemplateColumns: 'repeat(4, 1fr)',
                            gap: 'var(--space-2)'
                        }
                    },
                        this._renderQuickAction('🌿', 'Garden', 'garden'),
                        this._renderQuickAction('🧬', 'Breed', 'breeding'),
                        this._renderQuickAction('📦', 'Inventory', 'inventory'),
                        this._renderQuickAction('🛒', 'Market', 'market'),
                        this._renderQuickAction('📜', 'Quests', 'quests'),
                        this._renderQuickAction('🏆', 'Prestige', 'more', 'prestige'),
                        this._renderQuickAction('👷', 'Workers', 'more', 'workers'),
                        this._renderQuickAction('⚙️', 'More', 'more')
                    )
                )
            )
        );
    }

    _renderStatCard(label, value, icon, color) {
        return h('div', {
            class: 'cf-card',
            style: { textAlign: 'center', padding: 'var(--space-2)' }
        },
            h('div', { style: { fontSize: '1.25rem' } }, icon),
            h('div', { class: 'font-bold', style: { color } }, value),
            h('div', { class: 'text-xs text-muted' }, label)
        );
    }

    _renderQuickAction(icon, label, target, subview = null) {
        const dataset = { target };
        if (subview) dataset.subview = subview;

        return h('button', {
            class: 'cf-quick-action',
            dataset,
            style: {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: 'var(--space-2)',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer'
            }
        },
            h('span', { style: { fontSize: '1.25rem' } }, icon),
            h('span', { class: 'text-xs' }, label)
        );
    }

    _getNotifColor(type) {
        const colors = {
            info: 'var(--color-primary)',
            success: 'var(--color-success)',
            warning: 'var(--color-warning)',
            error: 'var(--color-danger)'
        };
        return colors[type] || colors.info;
    }
}

registerComponent('cf-dashboard', CFDashboard);
export default CFDashboard;
