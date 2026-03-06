/**
 * CertiFried Extension - Random Events Component
 * Dynamic events that affect gameplay
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency } from '../utils/format.js';
import { api } from '../api/client.js';

class CFRandomEvents extends CFBaseComponent {
    constructor() {
        super();
        this._eventsData = null;
        this._loading = true;
        this._refreshInterval = null;
    }

    _setupSubscriptions() {
        this.subscribe('player');
    }

    async onMount() {
        await this._loadData();

        // Auto-refresh events every 30 seconds
        this._refreshInterval = setInterval(() => {
            this._loadData();
        }, 30000);

        // Resolve event (choice events)
        this.on('click', '.cf-event-accept', async (e) => {
            await this._resolveEvent(e, 'accept');
        });

        this.on('click', '.cf-event-decline', async (e) => {
            await this._resolveEvent(e, 'decline');
        });

        // Dismiss event
        this.on('click', '.cf-event-dismiss', async (e) => {
            const btn = e.target.closest('.cf-event-dismiss');
            const eventId = parseInt(btn.dataset.eventId, 10);

            try {
                const result = await api.dismissRandomEvent(eventId);
                if (result.success) {
                    await this._loadData();
                }
            } catch (error) {
                this.emit('notification', { type: 'error', message: error.message });
            }
        });
    }

    onUnmount() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
        }
    }

    async _resolveEvent(e, choice) {
        const btn = e.target.closest('[data-event-id]');
        const eventId = parseInt(btn.dataset.eventId, 10);

        try {
            btn.disabled = true;
            btn.textContent = choice === 'accept' ? 'Rolling...' : 'Declining...';

            const result = await api.resolveRandomEvent(eventId, choice);
            if (result.success) {
                this.emit('notification', {
                    type: result.outcomeValue >= 0 ? 'success' : 'warning',
                    message: result.message
                });
                await this._loadData();
            }
        } catch (error) {
            this.emit('notification', { type: 'error', message: error.message });
            btn.disabled = false;
            btn.textContent = choice === 'accept' ? 'Accept' : 'Decline';
        }
    }

    async _loadData() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = !this._eventsData;

        if (isFirstLoad) {
            this._loading = true;
            this.render();
        }

        try {
            this._eventsData = await api.getActiveRandomEvents();
        } catch (error) {
            console.error('[CFRandomEvents] Load error:', error);
        } finally {
            this._loading = false;
            this.scheduleRender();
        }
    }

    render() {
        this.className = 'cf-random-events';

        if (this._loading && !this._eventsData) {
            this.setContent(
                h('div', { class: 'cf-loading' },
                    h('div', { class: 'cf-spinner' }),
                    h('p', {}, 'Loading events...')
                )
            );
            return;
        }

        if (!this._eventsData) {
            this.setContent(h('div', { class: 'cf-error' }, 'Failed to load events'));
            return;
        }

        const { events } = this._eventsData;

        this.setContent(
            h('div', { class: 'cf-random-events__header', style: { marginBottom: 'var(--space-4)' } },
                h('h2', { class: 'cf-section__title' }, 'Random Events'),
                h('p', { class: 'text-sm text-muted' }, 'Dynamic events that can help or hinder your progress')
            ),

            events.length === 0
                ? h('div', { class: 'cf-empty text-center py-8' },
                    h('div', { style: { fontSize: '48px', marginBottom: 'var(--space-3)' } }, '🎲'),
                    h('p', { class: 'text-muted' }, 'No active events right now'),
                    h('p', { class: 'text-xs text-muted mt-2' }, 'Events trigger randomly as you play')
                )
                : h('div', { class: 'cf-events-list' },
                    ...events.map(event => this._renderEventCard(event))
                )
        );
    }

    _renderEventCard(event) {
        const isChoice = event.requiresChoice;
        const isExpiring = event.expiresAt && (new Date(event.expiresAt) - new Date()) < 60000;

        // Event type styling
        const typeStyles = {
            positive: { bg: 'rgba(34, 197, 94, 0.1)', border: 'var(--color-success)', icon: '✨' },
            negative: { bg: 'rgba(239, 68, 68, 0.1)', border: 'var(--color-danger)', icon: '⚠️' },
            choice: { bg: 'rgba(234, 179, 8, 0.1)', border: 'var(--color-warning)', icon: '❓' },
            neutral: { bg: 'var(--bg-secondary)', border: 'var(--border-primary)', icon: '📋' }
        };

        const style = typeStyles[event.eventType] || typeStyles.neutral;

        return h('div', {
            class: `cf-card cf-event-card mb-3 ${isExpiring ? 'cf-expiring' : ''}`,
            style: {
                background: style.bg,
                borderColor: style.border,
                borderWidth: '2px'
            }
        },
            h('div', { class: 'cf-card__body' },
                // Header
                h('div', { style: { display: 'flex', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' } },
                    // Icon
                    h('div', {
                        style: {
                            width: '50px', height: '50px',
                            background: 'var(--bg-primary)',
                            borderRadius: 'var(--radius-md)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '24px'
                        }
                    }, event.icon || style.icon),

                    // Info
                    h('div', { style: { flex: 1 } },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' } },
                            h('h3', { class: 'font-semibold' }, event.name),
                            h('span', {
                                class: 'text-xs',
                                style: {
                                    padding: '2px 6px',
                                    borderRadius: '4px',
                                    background: style.border,
                                    color: 'white',
                                    textTransform: 'uppercase'
                                }
                            }, event.eventType)
                        ),
                        h('p', { class: 'text-sm text-muted mt-1' }, event.description)
                    )
                ),

                // Effect info (for non-choice events)
                !isChoice && event.effectType && h('div', {
                    class: 'cf-event-effect mb-3',
                    style: {
                        padding: 'var(--space-2)',
                        background: 'var(--bg-primary)',
                        borderRadius: 'var(--radius-sm)'
                    }
                },
                    h('span', { class: 'text-sm' },
                        `Effect: ${this._formatEffect(event.effectType, event.effectValue)}`
                    )
                ),

                // Timer
                event.expiresAt && h('div', {
                    class: 'text-xs mb-3',
                    style: { color: isExpiring ? 'var(--color-danger)' : 'var(--text-muted)' }
                },
                    `⏳ Expires: ${this._formatExpiry(event.expiresAt)}`
                ),

                // Actions
                h('div', { style: { display: 'flex', gap: 'var(--space-2)' } },
                    isChoice && h('button', {
                        class: 'cf-btn cf-btn--success cf-event-accept',
                        dataset: { eventId: event.id },
                        style: { flex: 1 }
                    }, '✓ Accept Risk'),

                    isChoice && h('button', {
                        class: 'cf-btn cf-btn--ghost cf-event-decline',
                        dataset: { eventId: event.id },
                        style: { flex: 1 }
                    }, '✗ Decline'),

                    !isChoice && h('button', {
                        class: 'cf-btn cf-btn--ghost cf-event-dismiss',
                        dataset: { eventId: event.id }
                    }, 'Dismiss')
                )
            )
        );
    }

    _formatEffect(effectType, effectValue) {
        const effectLabels = {
            'growth_speed': `Growth speed ${effectValue > 0 ? '+' : ''}${Math.round(effectValue * 100)}%`,
            'yield_bonus': `Yield ${effectValue > 0 ? '+' : ''}${Math.round(effectValue * 100)}%`,
            'quality_bonus': `Quality ${effectValue > 0 ? '+' : ''}${Math.round(effectValue * 100)}%`,
            'xp_bonus': `XP ${effectValue > 0 ? '+' : ''}${Math.round(effectValue * 100)}%`,
            'cash_bonus': `Cash ${effectValue > 0 ? '+' : ''}${Math.round(effectValue * 100)}%`,
            'heat_reduction': `Heat -${Math.round(effectValue * 100)}%`,
            'risky_deal': 'Risky deal - accept to roll the dice!',
            'research_choice': 'Research opportunity - results may vary',
            'faction_choice': 'Faction favor - could help or hurt'
        };

        return effectLabels[effectType] || `${effectType}: ${effectValue}`;
    }

    _formatExpiry(expiresAt) {
        const now = new Date();
        const expiry = new Date(expiresAt);
        const diffMs = expiry - now;

        if (diffMs <= 0) return 'Expired';

        const minutes = Math.floor(diffMs / 60000);
        const seconds = Math.floor((diffMs % 60000) / 1000);

        if (minutes < 1) return `${seconds}s`;
        if (minutes < 60) return `${minutes}m ${seconds}s`;

        const hours = Math.floor(minutes / 60);
        return `${hours}h ${minutes % 60}m`;
    }
}

registerComponent('cf-random-events', CFRandomEvents);
export default CFRandomEvents;
