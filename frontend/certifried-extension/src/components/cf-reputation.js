/**
 * Reputation Component
 * Faction-based reputation system with perks
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';

const PERK_LABELS = {
    yield_bonus: 'Yield',
    quality_bonus: 'Quality',
    grow_speed: 'Grow Speed',
    mutation_chance: 'Mutation Chance',
    sale_bonus: 'Sale Bonus',
    market_insight: 'Market Insight',
    trade_fee_reduction: 'Trade Fee Reduction',
    black_market_bonus: 'Black Market Bonus',
    heat_reduction: 'Heat Reduction',
    contact_unlock: 'New Contacts',
    immunity_chance: 'Raid Immunity',
    breeding_success: 'Breeding Success',
    mutation_discovery: 'Mutation Discovery',
    research_speed: 'Research Speed',
    raid_reduction: 'Raid Protection',
    vault_bonus: 'Vault Capacity',
    recovery_bonus: 'Raid Recovery'
};

class CFReputation extends CFBaseComponent {
    constructor() {
        super();
        this._factions = [];
        this._loading = true;
        this._error = null;
        this._selectedFaction = null;
    }

    async onMount() {
        await this._loadReputation();

        // View faction details
        this.on('click', '.cf-faction-card', (e) => {
            const card = e.target.closest('.cf-faction-card');
            if (!card) return;
            const factionId = parseInt(card.dataset.id, 10);
            this._selectedFaction = this._factions.find(f => f.id === factionId);
            this.render();
        });

        // Back button
        this.on('click', '.cf-back-btn', () => {
            this._selectedFaction = null;
            this.render();
        });
    }

    async _loadReputation() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._factions.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getReputation();
            if (response.success) {
                this._factions = response.factions || [];
            } else {
                this._error = response.error;
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    render() {
        this.className = 'cf-reputation';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadReputation() }, 'Retry')
                )
            );
            return;
        }

        // Faction detail view
        if (this._selectedFaction) {
            this.setContent(this._renderFactionDetail());
            return;
        }

        // Main view
        const content = [];

        content.push(
            h('div', { style: { marginBottom: 'var(--space-4)' } },
                h('h2', { class: 'cf-section__title' }, 'Reputation'),
                h('p', { class: 'text-sm text-muted' },
                    'Build standing with factions for exclusive perks'
                )
            )
        );

        // Faction cards
        for (const faction of this._factions) {
            content.push(this._renderFactionCard(faction));
        }

        this.setContent(...content);
    }

    _renderFactionCard(faction) {
        const progressPercent = faction.nextTier
            ? Math.min(100, (faction.reputation / faction.nextTier.repRequired) * 100)
            : 100;

        return h('div', {
            class: 'cf-card cf-faction-card',
            dataset: { id: faction.id.toString() },
            style: { marginBottom: 'var(--space-2)', cursor: 'pointer' }
        },
            h('div', { class: 'cf-card__body' },
                // Header
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' } },
                    h('span', { style: { fontSize: '1.75rem' } }, faction.icon),
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' }, faction.name),
                        h('div', { class: 'text-xs text-muted' },
                            `${faction.currentTier.icon} ${faction.currentTier.name}`
                        )
                    ),
                    h('div', { class: 'text-right' },
                        h('div', { class: 'font-semibold', style: { color: 'var(--color-primary)' } },
                            faction.reputation.toLocaleString()
                        ),
                        h('div', { class: 'text-xs text-muted' }, 'Reputation')
                    )
                ),

                // Progress to next tier
                faction.nextTier && h('div', {},
                    h('div', { class: 'text-xs text-muted mb-1' },
                        `Next: ${faction.nextTier.name} (${faction.nextTier.repRequired.toLocaleString()} rep)`
                    ),
                    h('div', { class: 'cf-progress' },
                        h('div', {
                            class: 'cf-progress__bar',
                            style: { width: `${progressPercent}%`, background: 'var(--color-primary)' }
                        })
                    )
                ),

                // Max tier indicator
                !faction.nextTier && h('div', {
                    class: 'text-xs',
                    style: { color: 'var(--color-success)' }
                }, '✓ Maximum tier reached'),

                // Tap to view hint
                h('div', { class: 'text-xs text-muted mt-2', style: { textAlign: 'right' } }, 'Tap for details →')
            )
        );
    }

    _renderFactionDetail() {
        const f = this._selectedFaction;

        return h('div', { class: 'cf-faction-detail' },
            // Back button
            h('button', {
                class: 'cf-btn cf-btn--ghost cf-back-btn mb-3',
                style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }
            },
                h('span', {}, '←'),
                h('span', {}, 'Back')
            ),

            // Header
            h('div', { class: 'cf-card mb-4' },
                h('div', { class: 'cf-card__body text-center' },
                    h('div', { style: { fontSize: '3rem', marginBottom: 'var(--space-2)' } }, f.icon),
                    h('h3', { class: 'font-semibold' }, f.name),
                    h('p', { class: 'text-sm text-muted mb-3' }, f.description),
                    h('div', { class: 'font-semibold', style: { color: 'var(--color-primary)', fontSize: '1.5rem' } },
                        f.reputation.toLocaleString()
                    ),
                    h('div', { class: 'text-xs text-muted' }, 'Total Reputation')
                )
            ),

            // Current tier perks
            h('div', { class: 'cf-card mb-4', style: { borderLeft: '3px solid var(--color-success)' } },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' },
                        `${f.currentTier.icon} ${f.currentTier.name} Perks`
                    )
                ),
                h('div', { class: 'cf-card__body' },
                    this._renderPerks(f.currentTier.perks)
                )
            ),

            // All tiers
            h('h4', { class: 'text-sm font-semibold text-muted mb-2' }, 'Reputation Tiers'),
            ...f.tiers.map(tier => this._renderTierCard(tier, f.reputation))
        );
    }

    _renderTierCard(tier, currentRep) {
        const isUnlocked = tier.isUnlocked;
        const isCurrent = currentRep >= tier.repRequired &&
            (!tier.nextTier || currentRep < tier.nextTier?.repRequired);

        return h('div', {
            class: 'cf-card mb-2',
            style: {
                opacity: isUnlocked ? 1 : 0.5,
                borderLeft: isCurrent ? '3px solid var(--color-primary)' : 'none'
            }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' } },
                    h('div', {},
                        h('span', { class: 'font-semibold' }, `${tier.icon} ${tier.name}`),
                        isUnlocked && h('span', {
                            class: 'text-xs ml-2',
                            style: { color: 'var(--color-success)' }
                        }, '✓ Unlocked')
                    ),
                    h('div', { class: 'text-xs text-muted' },
                        `${tier.repRequired.toLocaleString()} rep`
                    )
                ),
                this._renderPerks(tier.perks)
            )
        );
    }

    _renderPerks(perks) {
        const entries = Object.entries(perks).filter(([key]) => key !== 'description');

        if (entries.length === 0) {
            return h('div', { class: 'text-xs text-muted' }, 'Starting tier - no bonuses yet');
        }

        return h('div', { class: 'cf-perks', style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' } },
            ...entries.map(([key, value]) => {
                const label = PERK_LABELS[key] || key.replace(/_/g, ' ');
                let displayValue;

                if (typeof value === 'boolean') {
                    displayValue = '✓';
                } else if (typeof value === 'number') {
                    displayValue = value < 1 ? `+${Math.round(value * 100)}%` : `+${value}`;
                } else {
                    displayValue = value;
                }

                return h('div', {
                    class: 'cf-perk',
                    style: {
                        background: 'var(--bg-tertiary)',
                        padding: 'var(--space-1) var(--space-2)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 'var(--text-xs)'
                    }
                },
                    h('span', { style: { color: 'var(--color-success)' } }, displayValue),
                    h('span', { class: 'text-muted ml-1' }, label)
                );
            })
        );
    }
}

registerComponent('cf-reputation', CFReputation);
export default CFReputation;
