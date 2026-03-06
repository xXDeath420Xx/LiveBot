/**
 * CertiFried Extension - Quality Info Component
 * Shows quality tiers, advantages, and bonuses
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatPercent } from '../utils/format.js';

// Quality tier definitions
const QUALITY_TIERS = [
    { name: 'Trash', min: 0, max: 19, color: '#666666', icon: '🗑️', multiplier: 0.5 },
    { name: 'Low', min: 20, max: 39, color: '#999999', icon: '📦', multiplier: 0.75 },
    { name: 'Medium', min: 40, max: 59, color: '#ffffff', icon: '🌿', multiplier: 1.0 },
    { name: 'High', min: 60, max: 79, color: '#1eff00', icon: '⭐', multiplier: 1.5 },
    { name: 'Premium', min: 80, max: 89, color: '#0070dd', icon: '💎', multiplier: 2.0 },
    { name: 'Top Shelf', min: 90, max: 99, color: '#a335ee', icon: '👑', multiplier: 3.0 },
    { name: 'Legendary', min: 100, max: 100, color: '#ff8000', icon: '🏆', multiplier: 5.0 }
];

// Quality bonuses
const QUALITY_BONUSES = [
    { type: 'sale_price', label: 'Sale Price', desc: 'Higher quality sells for more' },
    { type: 'xp_gain', label: 'XP Gain', desc: 'Earn more XP from higher quality harvests' },
    { type: 'breeding_chance', label: 'Breeding Success', desc: 'Better breeding outcomes with quality parents' },
    { type: 'extraction_yield', label: 'Extraction Yield', desc: 'More concentrate from quality source material' },
    { type: 'tournament_score', label: 'Tournament Score', desc: 'Quality counts toward competition rankings' },
    { type: 'reputation', label: 'Reputation Gain', desc: 'Factions value quality merchandise more' },
    { type: 'dispensary', label: 'Dispensary Demand', desc: 'Customers prefer and pay more for quality' },
    { type: 'contract_bonus', label: 'Contract Bonus', desc: 'Exceed contract quality for bonus rewards' }
];

class CFQualityInfo extends CFBaseComponent {
    constructor() {
        super();
        this._activeTab = 'tiers'; // 'tiers' | 'bonuses' | 'tips'
    }

    onMount() {
        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });
    }

    render() {
        this.className = 'cf-quality-info';

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, 'Quality Guide'),
            h('p', { class: 'text-sm text-muted mb-3' },
                'Higher quality means better rewards across all game systems!'
            ),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'tiers' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'tiers' }
                }, 'Quality Tiers'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'bonuses' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'bonuses' }
                }, 'Bonuses'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'tips' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'tips' }
                }, 'Tips')
            ),

            this._activeTab === 'tiers' && this._renderTiersTab(),
            this._activeTab === 'bonuses' && this._renderBonusesTab(),
            this._activeTab === 'tips' && this._renderTipsTab()
        );
    }

    _renderTiersTab() {
        return h('div', { class: 'cf-quality-tiers' },
            ...QUALITY_TIERS.map(tier => {
                const multiplierDisplay = tier.multiplier >= 1
                    ? `${tier.multiplier}x`
                    : `${Math.round(tier.multiplier * 100)}%`;

                return h('div', {
                    class: 'cf-card mb-2',
                    style: { borderLeft: `4px solid ${tier.color}` }
                },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                            h('div', { style: { fontSize: '1.5rem' } }, tier.icon),
                            h('div', { style: { flex: 1 } },
                                h('div', {
                                    class: 'font-semibold',
                                    style: { color: tier.color }
                                }, tier.name),
                                h('div', { class: 'text-xs text-muted' },
                                    tier.min === tier.max
                                        ? `${tier.min}% quality`
                                        : `${tier.min}% - ${tier.max}% quality`
                                )
                            ),
                            h('div', { class: 'text-right' },
                                h('div', {
                                    class: 'font-bold',
                                    style: { color: tier.multiplier >= 1 ? 'var(--color-success)' : 'var(--color-danger)' }
                                }, multiplierDisplay),
                                h('div', { class: 'text-xs text-muted' }, 'value')
                            )
                        )
                    )
                );
            })
        );
    }

    _renderBonusesTab() {
        return h('div', { class: 'cf-quality-bonuses' },
            h('p', { class: 'text-sm text-muted mb-3' },
                'Quality affects these game systems:'
            ),
            ...QUALITY_BONUSES.map(bonus =>
                h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', { class: 'font-semibold' }, bonus.label),
                        h('div', { class: 'text-xs text-muted' }, bonus.desc),

                        // Example multipliers
                        h('div', {
                            class: 'mt-2',
                            style: {
                                display: 'flex',
                                gap: 'var(--space-2)',
                                flexWrap: 'wrap'
                            }
                        },
                            h('span', {
                                class: 'text-xs',
                                style: {
                                    padding: '2px 6px',
                                    borderRadius: 'var(--radius-sm)',
                                    background: 'var(--bg-tertiary)',
                                    color: '#1eff00'
                                }
                            }, 'High: +50%'),
                            h('span', {
                                class: 'text-xs',
                                style: {
                                    padding: '2px 6px',
                                    borderRadius: 'var(--radius-sm)',
                                    background: 'var(--bg-tertiary)',
                                    color: '#a335ee'
                                }
                            }, 'Top Shelf: +200%'),
                            h('span', {
                                class: 'text-xs',
                                style: {
                                    padding: '2px 6px',
                                    borderRadius: 'var(--radius-sm)',
                                    background: 'var(--bg-tertiary)',
                                    color: '#ff8000'
                                }
                            }, 'Legendary: +400%')
                        )
                    )
                )
            )
        );
    }

    _renderTipsTab() {
        const tips = [
            { icon: '🧬', title: 'Breeding', tip: 'Cross high-quality parent strains to increase offspring quality' },
            { icon: '⚡', title: 'Equipment', tip: 'Upgrade lighting and climate control for quality boosts' },
            { icon: '👷', title: 'Workers', tip: 'Train workers in quality-focused traits' },
            { icon: '🔬', title: 'Research', tip: 'Unlock quality enhancement technologies' },
            { icon: '⭐', title: 'Prestige', tip: 'Quality Boost prestige upgrade provides permanent bonus' },
            { icon: '🛡️', title: 'Reputation', tip: 'Some faction perks increase base quality' },
            { icon: '📍', title: 'Locations', tip: 'Premium locations provide quality bonuses' },
            { icon: '⏰', title: 'Timing', tip: 'Harvest at optimal time for maximum quality' }
        ];

        return h('div', { class: 'cf-quality-tips' },
            h('p', { class: 'text-sm text-muted mb-3' },
                'Ways to improve quality:'
            ),
            ...tips.map(tip =>
                h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)' } },
                            h('span', { style: { fontSize: '1.25rem' } }, tip.icon),
                            h('div', {},
                                h('div', { class: 'font-semibold text-sm' }, tip.title),
                                h('div', { class: 'text-xs text-muted' }, tip.tip)
                            )
                        )
                    )
                )
            )
        );
    }
}

registerComponent('cf-quality-info', CFQualityInfo);
export default CFQualityInfo;
