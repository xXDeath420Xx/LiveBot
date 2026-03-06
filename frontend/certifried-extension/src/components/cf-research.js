/**
 * Research Tree Component
 * Tech tree progression system
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency, formatTimeRemaining } from '../utils/format.js';

const CATEGORY_INFO = {
    cultivation: { name: 'Cultivation', icon: '🌱', color: '#22c55e' },
    processing: { name: 'Processing', icon: '⚗️', color: '#8b5cf6' },
    business: { name: 'Business', icon: '💼', color: '#f59e0b' },
    expansion: { name: 'Expansion', icon: '🏗️', color: '#3b82f6' }
};

const STATUS_COLORS = {
    locked: '#6b7280',
    available: '#22c55e',
    researching: '#f59e0b',
    completed: '#8b5cf6'
};

class CFResearch extends CFBaseComponent {
    constructor() {
        super();
        this._tree = {};
        this._allNodes = [];
        this._stats = { total: 0, completed: 0, completion: 0 };
        this._inProgress = null;
        this._player = { cash: 0, xp: 0, level: 1 };
        this._loading = true;
        this._error = null;
        this._activeCategory = 'cultivation';
        this._timerInterval = null;
    }

    async onMount() {
        await this._loadResearch();

        // Start timer for in-progress research
        this._timerInterval = setInterval(() => {
            if (this._inProgress) {
                this.render();
            }
        }, 1000);

        // Category tabs
        this.on('click', '.cf-category-tab', (e) => {
            const tab = e.target.closest('.cf-category-tab');
            if (!tab) return;
            this._activeCategory = tab.dataset.category;
            this.render();
        });

        // Start research
        this.on('click', '.cf-start-research', async (e) => {
            const btn = e.target.closest('.cf-start-research');
            if (!btn || btn.disabled) return;
            await this._startResearch(parseInt(btn.dataset.id, 10));
        });

        // Claim research
        this.on('click', '.cf-claim-research', async (e) => {
            const btn = e.target.closest('.cf-claim-research');
            if (!btn) return;
            await this._claimResearch(parseInt(btn.dataset.id, 10));
        });

        // Cancel research
        this.on('click', '.cf-cancel-research', async (e) => {
            const btn = e.target.closest('.cf-cancel-research');
            if (!btn) return;
            if (confirm('Cancel research? You will only get 50% refund.')) {
                await this._cancelResearch(parseInt(btn.dataset.id, 10));
            }
        });
    }

    onUnmount() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
        }
    }

    async _loadResearch() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._allNodes.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getResearchTree();
            if (response.success) {
                this._tree = response.tree || {};
                this._allNodes = response.allNodes || [];
                this._stats = response.stats || { total: 0, completed: 0, completion: 0 };
                this._inProgress = response.inProgress;
                this._player = response.player || { cash: 0, xp: 0, level: 1 };
            } else {
                this._error = response.error;
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    async _startResearch(researchId) {
        // Find the node to start
        const node = this._allNodes.find(n => n.id === researchId);
        if (!node) return;

        // Optimistic update - show as researching immediately
        const oldInProgress = this._inProgress;
        const oldNodeStatus = node.status;
        const oldPlayerCash = this._player.cash;
        const oldPlayerXp = this._player.xp;

        this._inProgress = {
            id: researchId,
            name: node.name,
            completesAt: new Date(Date.now() + node.researchTimeHours * 3600000).toISOString()
        };
        node.status = 'researching';
        node.completesAt = this._inProgress.completesAt;
        this._player.cash -= node.costCash;
        this._player.xp -= node.costXp;
        this.scheduleRender();

        try {
            const response = await api.startResearch(researchId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                // Background refresh for accurate server state
                this._loadResearch();
            } else {
                // Rollback on failure
                this._inProgress = oldInProgress;
                node.status = oldNodeStatus;
                node.completesAt = null;
                this._player.cash = oldPlayerCash;
                this._player.xp = oldPlayerXp;
                this.scheduleRender();
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            // Rollback on error
            this._inProgress = oldInProgress;
            node.status = oldNodeStatus;
            node.completesAt = null;
            this._player.cash = oldPlayerCash;
            this._player.xp = oldPlayerXp;
            this.scheduleRender();
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _claimResearch(researchId) {
        // Optimistic update - mark as completed immediately
        const node = this._allNodes.find(n => n.id === researchId);
        const oldInProgress = this._inProgress;
        const oldNodeStatus = node?.status;
        const oldStats = { ...this._stats };

        if (node) {
            node.status = 'completed';
        }
        this._inProgress = null;
        this._stats.completed++;
        this._stats.completion = Math.round((this._stats.completed / this._stats.total) * 100);
        this.scheduleRender();

        try {
            const response = await api.claimResearch(researchId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                if (response.unlock) {
                    this.emit('notification', { type: 'info', message: response.unlock });
                }
                // Background refresh for accurate server state
                this._loadResearch();
            } else {
                // Rollback on failure
                if (node) node.status = oldNodeStatus;
                this._inProgress = oldInProgress;
                this._stats = oldStats;
                this.scheduleRender();
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            // Rollback on error
            if (node) node.status = oldNodeStatus;
            this._inProgress = oldInProgress;
            this._stats = oldStats;
            this.scheduleRender();
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _cancelResearch(researchId) {
        // Optimistic update - clear in-progress immediately
        const node = this._allNodes.find(n => n.id === researchId);
        const oldInProgress = this._inProgress;
        const oldNodeStatus = node?.status;

        this._inProgress = null;
        if (node) {
            node.status = 'available';
            node.completesAt = null;
        }
        this.scheduleRender();

        try {
            const response = await api.cancelResearch(researchId);
            if (response.success) {
                this.emit('notification', { type: 'warning', message: response.message });
                // Background refresh for accurate server state (get refund amount etc)
                this._loadResearch();
            } else {
                // Rollback on failure
                this._inProgress = oldInProgress;
                if (node) node.status = oldNodeStatus;
                this.scheduleRender();
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            // Rollback on error
            this._inProgress = oldInProgress;
            if (node) node.status = oldNodeStatus;
            this.scheduleRender();
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-research';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadResearch() }, 'Retry')
                )
            );
            return;
        }

        const content = [];

        // Header
        content.push(
            h('div', { style: { marginBottom: 'var(--space-4)' } },
                h('h2', { class: 'cf-section__title' }, 'Research Lab'),
                h('p', { class: 'text-sm text-muted' },
                    `Completed ${this._stats.completed}/${this._stats.total} (${this._stats.completion}%)`
                )
            )
        );

        // Progress bar
        content.push(
            h('div', { class: 'cf-progress mb-3' },
                h('div', {
                    class: 'cf-progress__bar',
                    style: { width: `${this._stats.completion}%`, background: 'var(--color-primary)' }
                })
            )
        );

        // In-progress research banner
        if (this._inProgress) {
            const timeLeft = new Date(this._inProgress.completesAt) - new Date();
            const isReady = timeLeft <= 0;

            content.push(
                h('div', {
                    class: 'cf-card mb-4',
                    style: { borderLeft: `3px solid ${isReady ? 'var(--color-success)' : 'var(--color-warning)'}` }
                },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                            h('div', {},
                                h('div', { class: 'text-xs text-muted' }, 'Currently Researching'),
                                h('div', { class: 'font-semibold' }, this._inProgress.name)
                            ),
                            isReady
                                ? h('button', {
                                    class: 'cf-btn cf-btn--success cf-claim-research',
                                    dataset: { id: this._inProgress.id.toString() }
                                }, 'Claim!')
                                : h('div', { class: 'text-right' },
                                    h('div', { class: 'text-sm', style: { color: 'var(--color-warning)' } },
                                        formatTimeRemaining(timeLeft)
                                    ),
                                    h('button', {
                                        class: 'cf-btn cf-btn--ghost cf-btn--sm cf-cancel-research',
                                        dataset: { id: this._inProgress.id.toString() },
                                        style: { marginTop: 'var(--space-1)' }
                                    }, 'Cancel')
                                )
                        )
                    )
                )
            );
        }

        // Category tabs
        content.push(
            h('div', { class: 'cf-tabs mb-3' },
                ...Object.entries(CATEGORY_INFO).map(([key, info]) => {
                    const nodes = this._tree[key] || [];
                    const completed = nodes.filter(n => n.status === 'completed').length;
                    return h('button', {
                        class: `cf-tab cf-category-tab ${this._activeCategory === key ? 'cf-tab--active' : ''}`,
                        dataset: { category: key },
                        style: { borderBottom: this._activeCategory === key ? `2px solid ${info.color}` : 'none' }
                    }, `${info.icon} ${completed}/${nodes.length}`);
                })
            )
        );

        // Category header
        const catInfo = CATEGORY_INFO[this._activeCategory];
        content.push(
            h('div', { class: 'mb-3' },
                h('h3', { style: { color: catInfo.color } }, `${catInfo.icon} ${catInfo.name}`)
            )
        );

        // Research nodes grid
        const nodes = this._tree[this._activeCategory] || [];
        const byTier = {};
        for (const node of nodes) {
            if (!byTier[node.tier]) byTier[node.tier] = [];
            byTier[node.tier].push(node);
        }

        for (const [tier, tierNodes] of Object.entries(byTier)) {
            content.push(
                h('div', { class: 'cf-research-tier mb-3' },
                    h('div', { class: 'text-xs text-muted mb-2' }, `Tier ${tier}`),
                    h('div', { class: 'cf-research-grid' },
                        ...tierNodes.map(node => this._renderNode(node))
                    )
                )
            );
        }

        // Player resources
        content.push(
            h('div', {
                class: 'cf-card mt-4',
                style: { background: 'var(--bg-secondary)' }
            },
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'flex', justifyContent: 'space-around', textAlign: 'center' } },
                        h('div', {},
                            h('div', { class: 'text-xs text-muted' }, 'Cash'),
                            h('div', { class: 'font-semibold', style: { color: 'var(--color-success)' } },
                                formatCurrency(this._player.cash)
                            )
                        ),
                        h('div', {},
                            h('div', { class: 'text-xs text-muted' }, 'XP'),
                            h('div', { class: 'font-semibold', style: { color: 'var(--color-primary)' } },
                                this._player.xp.toLocaleString()
                            )
                        )
                    )
                )
            )
        );

        this.setContent(...content);
    }

    _renderNode(node) {
        const statusColor = STATUS_COLORS[node.status] || '#666';
        const isResearching = node.status === 'researching';
        const isCompleted = node.status === 'completed';
        const isAvailable = node.status === 'available';
        const canStart = isAvailable && node.prereqsMet && node.canAfford && !this._inProgress;

        let timeDisplay = null;
        if (isResearching && node.completesAt) {
            const timeLeft = new Date(node.completesAt) - new Date();
            timeDisplay = timeLeft > 0 ? formatTimeRemaining(timeLeft) : 'Ready!';
        }

        return h('div', {
            class: 'cf-card cf-research-node',
            style: {
                marginBottom: 'var(--space-2)',
                opacity: node.status === 'locked' ? 0.5 : 1,
                borderLeft: `3px solid ${statusColor}`
            }
        },
            h('div', { class: 'cf-card__body' },
                // Icon and name
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' } },
                    h('span', { style: { fontSize: '1.5rem' } }, node.icon),
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' }, node.name),
                        h('div', {
                            class: 'text-xs',
                            style: { color: statusColor, textTransform: 'capitalize' }
                        }, isResearching && timeDisplay ? timeDisplay : node.status)
                    )
                ),

                // Description
                h('p', { class: 'text-xs text-muted mb-2' }, node.description),

                // Unlock info
                node.unlockType && h('div', { class: 'text-xs mb-2', style: { color: 'var(--color-primary)' } },
                    node.unlockType === 'bonus'
                        ? `+${Math.round(node.unlockValue * 100)}% ${node.unlockKey.replace(/_/g, ' ')}`
                        : `Unlocks: ${node.unlockKey}`
                ),

                // Prerequisites
                node.prerequisites.length > 0 && !isCompleted && h('div', { class: 'text-xs mb-2' },
                    h('span', { class: 'text-muted' }, 'Requires: '),
                    node.prereqsMet
                        ? h('span', { style: { color: 'var(--color-success)' } }, '✓ Prerequisites met')
                        : h('span', { style: { color: 'var(--color-danger)' } }, node.prerequisites.join(', '))
                ),

                // Costs (if not completed)
                !isCompleted && h('div', { class: 'text-xs mb-2', style: { display: 'flex', gap: 'var(--space-3)' } },
                    h('span', { style: { color: node.canAfford ? 'var(--text-muted)' : 'var(--color-danger)' } },
                        `$${node.costCash.toLocaleString()}`
                    ),
                    h('span', { style: { color: node.canAfford ? 'var(--text-muted)' : 'var(--color-danger)' } },
                        `${node.costXp.toLocaleString()} XP`
                    ),
                    h('span', { class: 'text-muted' }, `${node.researchTimeHours}h`)
                ),

                // Action button
                !isCompleted && !isResearching && h('button', {
                    class: `cf-btn cf-btn--sm cf-start-research ${canStart ? 'cf-btn--primary' : ''}`,
                    dataset: { id: node.id.toString() },
                    disabled: !canStart,
                    style: { width: '100%', marginTop: 'var(--space-2)' }
                }, this._inProgress ? 'Busy' : (canStart ? 'Research' : 'Locked')),

                // Completed badge
                isCompleted && h('div', {
                    class: 'text-xs text-center',
                    style: { color: 'var(--color-success)', marginTop: 'var(--space-2)' }
                }, '✓ Completed')
            )
        );
    }
}

registerComponent('cf-research', CFResearch);
export default CFResearch;
