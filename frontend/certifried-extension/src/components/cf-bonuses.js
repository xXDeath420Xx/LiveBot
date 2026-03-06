/**
 * CertiFried Extension - Bonuses Component
 * Shows all active bonuses from different sources
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { store } from '../state/store.js';

// Bonus categories and their colors
const BONUS_SOURCES = {
    prestige: { name: 'Prestige', icon: '⭐', color: 'var(--color-legendary)' },
    equipment: { name: 'Equipment', icon: '🔧', color: 'var(--color-rare)' },
    reputation: { name: 'Reputation', icon: '🛡️', color: 'var(--color-epic)' },
    skills: { name: 'Skills', icon: '📚', color: 'var(--color-success)' },
    workers: { name: 'Workers', icon: '👷', color: 'var(--color-warning)' },
    facility: { name: 'Facility', icon: '🏭', color: 'var(--color-primary)' },
    events: { name: 'Events', icon: '🎉', color: 'var(--color-danger)' },
    cartel: { name: 'Cartel', icon: '🤝', color: 'var(--color-success)' },
    territory: { name: 'Territory', icon: '🚩', color: 'var(--color-epic)' }
};

// Bonus type labels
const BONUS_LABELS = {
    grow_speed: 'Grow Speed',
    yield: 'Yield',
    quality: 'Quality',
    xp: 'XP Gain',
    cash: 'Cash Multiplier',
    market: 'Market Prices',
    heat: 'Heat Reduction',
    breeding: 'Breeding Success',
    extraction: 'Extraction Yield',
    worker_efficiency: 'Worker Efficiency',
    offline: 'Offline Earnings',
    storage: 'Storage Capacity',
    raid_defense: 'Raid Defense',
    mutation: 'Mutation Chance',
    daily: 'Daily Rewards',
    tournament: 'Tournament Bonus'
};

class CFBonuses extends CFBaseComponent {
    constructor() {
        super();
        this._activeTab = 'summary'; // 'summary' | 'by-source' | 'by-type'
    }

    _setupSubscriptions() {
        this.subscribe('player');
        this.subscribe('equipment');
        this.subscribe('skills');
        this.subscribe('reputation');
        this.subscribe('cartel');
    }

    onMount() {
        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });
    }

    _gatherAllBonuses() {
        const bonuses = [];
        const player = this.getState('player') || {};

        // Prestige bonuses
        const prestigeUpgrades = player.prestigeUpgrades || [];
        prestigeUpgrades.forEach(upgrade => {
            bonuses.push({
                source: 'prestige',
                type: upgrade.effectType || upgrade.type,
                value: upgrade.effectValue || upgrade.value || 0,
                name: upgrade.name,
                permanent: true
            });
        });

        // Equipment bonuses
        const equipment = this.getState('equipment.activeBonuses') || {};
        Object.entries(equipment).forEach(([type, value]) => {
            if (value > 0) {
                bonuses.push({
                    source: 'equipment',
                    type,
                    value,
                    name: BONUS_LABELS[type] || type,
                    permanent: false
                });
            }
        });

        // Skill bonuses
        const skills = this.getState('skills.activeBonuses') || [];
        skills.forEach(skill => {
            bonuses.push({
                source: 'skills',
                type: skill.effectType || skill.type,
                value: skill.effectValue || skill.value || 0,
                name: skill.name,
                permanent: true
            });
        });

        // Reputation perks
        const reputation = this.getState('reputation.activePerks') || [];
        reputation.forEach(perk => {
            bonuses.push({
                source: 'reputation',
                type: perk.effectType || perk.type,
                value: perk.effectValue || perk.value || 0,
                name: perk.name,
                permanent: false
            });
        });

        // Worker bonuses
        const workers = this.getState('workers.activeBonuses') || {};
        Object.entries(workers).forEach(([type, value]) => {
            if (value > 0) {
                bonuses.push({
                    source: 'workers',
                    type,
                    value,
                    name: BONUS_LABELS[type] || type,
                    permanent: false
                });
            }
        });

        // Cartel bonuses
        const cartel = this.getState('cartel.bonuses') || {};
        Object.entries(cartel).forEach(([type, value]) => {
            if (value > 0) {
                bonuses.push({
                    source: 'cartel',
                    type,
                    value,
                    name: BONUS_LABELS[type] || type,
                    permanent: false
                });
            }
        });

        // Territory bonuses
        const territories = this.getState('territories.bonuses') || {};
        Object.entries(territories).forEach(([type, value]) => {
            if (value > 0) {
                bonuses.push({
                    source: 'territory',
                    type,
                    value,
                    name: BONUS_LABELS[type] || type,
                    permanent: false
                });
            }
        });

        return bonuses;
    }

    _aggregateBonusesByType(bonuses) {
        const aggregated = {};
        bonuses.forEach(bonus => {
            const type = bonus.type;
            if (!aggregated[type]) {
                aggregated[type] = {
                    type,
                    name: BONUS_LABELS[type] || type,
                    total: 0,
                    sources: []
                };
            }
            aggregated[type].total += bonus.value;
            aggregated[type].sources.push(bonus);
        });
        return Object.values(aggregated).sort((a, b) => b.total - a.total);
    }

    _aggregateBonusesBySource(bonuses) {
        const aggregated = {};
        bonuses.forEach(bonus => {
            const source = bonus.source;
            if (!aggregated[source]) {
                aggregated[source] = {
                    source,
                    info: BONUS_SOURCES[source] || { name: source, icon: '❓', color: 'var(--text-muted)' },
                    bonuses: []
                };
            }
            aggregated[source].bonuses.push(bonus);
        });
        return Object.values(aggregated).sort((a, b) => b.bonuses.length - a.bonuses.length);
    }

    render() {
        this.className = 'cf-bonuses';
        const allBonuses = this._gatherAllBonuses();

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, '✨ Active Bonuses'),

            // Summary stats
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
                            h('div', { class: 'text-lg font-bold' }, allBonuses.length),
                            h('div', { class: 'text-xs text-muted' }, 'Active')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-legendary)' } },
                                allBonuses.filter(b => b.permanent).length
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Permanent')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold' },
                                Object.keys(BONUS_SOURCES).filter(s =>
                                    allBonuses.some(b => b.source === s)
                                ).length
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Sources')
                        )
                    )
                )
            ),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'summary' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'summary' }
                }, 'Summary'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'by-source' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'by-source' }
                }, 'By Source'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'by-type' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'by-type' }
                }, 'By Type')
            ),

            // Tab content
            this._activeTab === 'summary' && this._renderSummaryTab(allBonuses),
            this._activeTab === 'by-source' && this._renderBySourceTab(allBonuses),
            this._activeTab === 'by-type' && this._renderByTypeTab(allBonuses)
        );
    }

    _renderSummaryTab(bonuses) {
        const byType = this._aggregateBonusesByType(bonuses);

        if (byType.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Active Bonuses'),
                h('p', { class: 'cf-empty__description' },
                    'Earn bonuses from prestige, equipment, skills, reputation, and more!'
                )
            );
        }

        return h('div', { class: 'cf-bonuses-summary' },
            ...byType.map(item => {
                const isPercent = item.total < 10;
                const display = isPercent
                    ? `+${Math.round(item.total * 100)}%`
                    : `+${item.total.toLocaleString()}`;

                return h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                            h('div', {},
                                h('div', { class: 'font-semibold' }, item.name),
                                h('div', { class: 'text-xs text-muted' },
                                    `From ${item.sources.length} source${item.sources.length > 1 ? 's' : ''}`
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
        );
    }

    _renderBySourceTab(bonuses) {
        const bySource = this._aggregateBonusesBySource(bonuses);

        if (bySource.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Bonus Sources'),
                h('p', { class: 'cf-empty__description' }, 'Start earning bonuses!')
            );
        }

        return h('div', { class: 'cf-bonuses-by-source' },
            ...bySource.map(group =>
                h('div', { class: 'cf-card mb-3' },
                    h('div', {
                        class: 'cf-card__header',
                        style: { borderLeft: `3px solid ${group.info.color}` }
                    },
                        h('h4', { class: 'cf-card__title' },
                            h('span', { style: { marginRight: 'var(--space-2)' } }, group.info.icon),
                            group.info.name,
                            h('span', { class: 'text-xs text-muted ml-2' }, `(${group.bonuses.length})`)
                        )
                    ),
                    h('div', { class: 'cf-card__body' },
                        ...group.bonuses.map(bonus => {
                            const isPercent = bonus.value < 10;
                            const display = isPercent
                                ? `+${Math.round(bonus.value * 100)}%`
                                : `+${bonus.value.toLocaleString()}`;

                            return h('div', {
                                style: {
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    marginBottom: 'var(--space-1)'
                                }
                            },
                                h('span', { class: 'text-sm' },
                                    bonus.name,
                                    bonus.permanent && h('span', {
                                        class: 'text-xs ml-1',
                                        style: { color: 'var(--color-legendary)' }
                                    }, '★')
                                ),
                                h('span', {
                                    class: 'text-sm font-semibold',
                                    style: { color: 'var(--color-success)' }
                                }, display)
                            );
                        })
                    )
                )
            )
        );
    }

    _renderByTypeTab(bonuses) {
        const byType = this._aggregateBonusesByType(bonuses);

        if (byType.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Bonus Types'),
                h('p', { class: 'cf-empty__description' }, 'Unlock bonuses to see them here!')
            );
        }

        return h('div', { class: 'cf-bonuses-by-type' },
            ...byType.map(item => {
                const isPercent = item.total < 10;
                const totalDisplay = isPercent
                    ? `+${Math.round(item.total * 100)}%`
                    : `+${item.total.toLocaleString()}`;

                return h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', {
                            style: {
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                marginBottom: 'var(--space-2)'
                            }
                        },
                            h('div', { class: 'font-semibold' }, item.name),
                            h('div', {
                                class: 'font-bold',
                                style: { color: 'var(--color-success)' }
                            }, totalDisplay)
                        ),

                        // Breakdown
                        h('div', { style: { borderTop: '1px solid var(--border-primary)', paddingTop: 'var(--space-2)' } },
                            ...item.sources.map(source => {
                                const info = BONUS_SOURCES[source.source] || { icon: '❓', name: source.source };
                                const valueDisplay = isPercent
                                    ? `+${Math.round(source.value * 100)}%`
                                    : `+${source.value.toLocaleString()}`;

                                return h('div', {
                                    class: 'text-xs',
                                    style: {
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        marginBottom: '2px'
                                    }
                                },
                                    h('span', { class: 'text-muted' },
                                        `${info.icon} ${info.name}`
                                    ),
                                    h('span', {}, valueDisplay)
                                );
                            })
                        )
                    )
                );
            })
        );
    }
}

registerComponent('cf-bonuses', CFBonuses);
export default CFBonuses;
