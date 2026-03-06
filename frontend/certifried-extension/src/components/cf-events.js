/**
 * CertiFried Extension - Seasonal Events Component
 * Shows active events and participation
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatTimeRemaining } from '../utils/format.js';
import { api } from '../api/client.js';

class CFEvents extends CFBaseComponent {
    constructor() {
        super();
        this._events = [];
        this._isLoading = true;
        this._selectedEvent = null;
    }

    onMount() {
        this._loadEvents();

        // Join event
        this.on('click', '.cf-event__join-btn', async (e) => {
            const btn = e.target.closest('.cf-event__join-btn');
            if (!btn) return;
            const eventId = parseInt(btn.dataset.eventId, 10);
            await this._joinEvent(eventId);
        });

        // Claim reward
        this.on('click', '.cf-event__claim-btn', async (e) => {
            const btn = e.target.closest('.cf-event__claim-btn');
            if (!btn || btn.disabled) return;
            const eventId = parseInt(btn.dataset.eventId, 10);
            const milestoneIndex = parseInt(btn.dataset.milestone, 10);
            await this._claimReward(eventId, milestoneIndex);
        });

        // View details
        this.on('click', '.cf-event-card', (e) => {
            if (e.target.closest('button')) return; // Don't trigger on button clicks
            const card = e.target.closest('.cf-event-card');
            if (!card) return;
            const eventId = parseInt(card.dataset.eventId, 10);
            this._selectedEvent = this._events.find(ev => ev.id === eventId);
            this.render();
        });

        // Back to list
        this.on('click', '.cf-events__back', () => {
            this._selectedEvent = null;
            this.render();
        });
    }

    async _loadEvents() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._events.length === 0;

        if (isFirstLoad) {
            this._isLoading = true;
            this.render();
        }

        try {
            const data = await api.getActiveEvents();
            this._events = data.events || [];

        } catch (error) {
            console.error('Failed to load events:', error);
        } finally {
            this._isLoading = false;
            this.scheduleRender();
        }
    }

    async _joinEvent(eventId) {
        // Find the event
        const event = this._events.find(e => e.id === eventId);
        if (!event) return;

        // Optimistic update - join immediately
        const oldHasJoined = event.hasJoined;
        event.hasJoined = true;
        event.pointsEarned = 0;
        event.rewardsClaimed = [];
        this.scheduleRender();

        try {
            await api.joinEvent(eventId);

            this.emit('notification', {
                type: 'success',
                message: `Joined ${event.name || 'event'}!`
            });

        } catch (error) {
            // Rollback on error
            event.hasJoined = oldHasJoined;
            event.pointsEarned = undefined;
            event.rewardsClaimed = undefined;
            this.scheduleRender();

            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to join event'
            });
        }
    }

    async _claimReward(eventId, milestoneIndex) {
        try {
            const result = await api.claimEventReward(eventId, milestoneIndex);

            // Update local state
            const event = this._events.find(e => e.id === eventId);
            if (event) {
                event.rewardsClaimed = [...(event.rewardsClaimed || []), milestoneIndex];
            }

            this.emit('notification', {
                type: 'success',
                message: `Reward claimed: ${result.reward?.reward || 'Success'}!`
            });

            // Update player currency if cash awarded
            if (result.reward?.cashAwarded) {
                const currentCash = this.getState('player.currency') || 0;
                this.setState('player.currency', currentCash + result.reward.cashAwarded);
            }

            this.render();

        } catch (error) {
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to claim reward'
            });
        }
    }

    render() {
        this.className = 'cf-events cf-section';

        if (this._isLoading) {
            this.setContent(
                h('div', { class: 'cf-loading' },
                    h('div', { class: 'cf-spinner' })
                )
            );
            return;
        }

        // Show detail view if event selected
        if (this._selectedEvent) {
            this._renderEventDetail();
            return;
        }

        // List view
        this.setContent(
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Events')
            ),

            this._events.length === 0
                ? h('div', { class: 'cf-empty' },
                    h('p', { class: 'cf-empty__title' }, 'No Active Events'),
                    h('p', { class: 'cf-empty__description' }, 'Check back later for seasonal events and competitions!')
                )
                : h('div', { class: 'cf-events__list' },
                    ...this._events.map(event => this._renderEventCard(event))
                )
        );
    }

    _renderEventCard(event) {
        const timeLeft = formatTimeRemaining(event.remainingMs);

        return h('div', {
            class: `cf-event-card ${event.hasJoined ? 'cf-event-card--joined' : ''}`,
            dataset: { eventId: event.id.toString() }
        },
            // Event header
            h('div', { class: 'cf-event-card__header' },
                h('div', { class: 'cf-event-card__icon' }, this._getEventIcon(event.type)),
                h('div', { class: 'cf-event-card__info' },
                    h('h3', { class: 'cf-event-card__name' }, event.name),
                    h('span', { class: 'cf-event-card__type cf-badge' }, event.type)
                ),
                h('div', { class: 'cf-event-card__time' },
                    h('span', { class: 'text-xs text-muted' }, 'Ends in'),
                    h('span', { class: 'cf-event-card__countdown' }, timeLeft)
                )
            ),

            // Description
            h('p', { class: 'cf-event-card__desc' }, event.description),

            // Bonus display
            event.bonusType && h('div', { class: 'cf-event-card__bonus' },
                h('span', {}, `🎁 Active Bonus: +${Math.round((event.bonusValue - 1) * 100)}% ${event.bonusType.replace('_', ' ')}`)
            ),

            // Progress (if joined)
            event.hasJoined && h('div', { class: 'cf-event-card__progress' },
                h('span', { class: 'text-sm' }, `Your Points: ${event.pointsEarned}`)
            ),

            // Actions
            h('div', { class: 'cf-event-card__actions' },
                !event.hasJoined
                    ? h('button', {
                        class: 'cf-event__join-btn cf-btn cf-btn--primary cf-btn--sm',
                        dataset: { eventId: event.id.toString() }
                    }, 'Join Event')
                    : h('button', {
                        class: 'cf-btn cf-btn--secondary cf-btn--sm'
                    }, 'View Details →')
            )
        );
    }

    _renderEventDetail() {
        const event = this._selectedEvent;
        const rewards = event.rewards?.milestones || [];

        this.setContent(
            // Back button
            h('button', { class: 'cf-events__back cf-btn cf-btn--ghost mb-3' },
                h('span', {}, '← Back to Events')
            ),

            // Event header
            h('div', { class: 'cf-event-detail__header' },
                h('h2', {}, event.name),
                h('p', { class: 'text-muted' }, event.description),
                event.bonusType && h('div', { class: 'cf-badge cf-badge--success mt-2' },
                    `Active: +${Math.round((event.bonusValue - 1) * 100)}% ${event.bonusType.replace('_', ' ')}`
                )
            ),

            // Player progress
            h('div', { class: 'cf-event-detail__progress mt-4' },
                h('h3', { class: 'text-sm font-semibold mb-2' }, 'Your Progress'),
                h('div', { class: 'cf-event-detail__points' },
                    h('span', { class: 'cf-event-detail__points-value' }, event.pointsEarned.toString()),
                    h('span', { class: 'text-muted' }, ' points')
                )
            ),

            // Milestones/Rewards
            rewards.length > 0 && h('div', { class: 'cf-event-detail__milestones mt-4' },
                h('h3', { class: 'text-sm font-semibold mb-2' }, 'Milestone Rewards'),
                h('div', { class: 'cf-milestones-list' },
                    ...rewards.map((milestone, i) => this._renderMilestone(event, milestone, i))
                )
            ),

            // Time remaining
            h('div', { class: 'cf-event-detail__footer mt-4 text-center text-muted' },
                h('span', {}, `Event ends in ${event.remainingDays} days`)
            )
        );
    }

    _renderMilestone(event, milestone, index) {
        const isUnlocked = event.pointsEarned >= milestone.points;
        const isClaimed = event.rewardsClaimed?.includes(index);
        const canClaim = isUnlocked && !isClaimed;

        let statusClass = 'cf-milestone--locked';
        if (isClaimed) statusClass = 'cf-milestone--claimed';
        else if (isUnlocked) statusClass = 'cf-milestone--unlocked';

        return h('div', { class: `cf-milestone ${statusClass}` },
            h('div', { class: 'cf-milestone__points' },
                h('span', {}, `${milestone.points} pts`)
            ),
            h('div', { class: 'cf-milestone__reward' },
                h('span', {}, milestone.reward)
            ),
            h('div', { class: 'cf-milestone__action' },
                isClaimed
                    ? h('span', { class: 'cf-badge cf-badge--success' }, '✓ Claimed')
                    : canClaim
                        ? h('button', {
                            class: 'cf-event__claim-btn cf-btn cf-btn--primary cf-btn--sm',
                            dataset: { eventId: event.id.toString(), milestone: index.toString() }
                        }, 'Claim')
                        : h('span', { class: 'text-muted text-xs' }, `${milestone.points - event.pointsEarned} more`)
            )
        );
    }

    _getEventIcon(type) {
        const icons = {
            seasonal: '🌸',
            holiday: '🎄',
            special: '⭐',
            community: '🤝'
        };
        return icons[type] || '🎉';
    }
}

registerComponent('cf-events', CFEvents);
export default CFEvents;
