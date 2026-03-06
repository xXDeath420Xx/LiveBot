/**
 * CertiFried Extension - Skills Component
 * Skill tree with unlockable upgrades
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency } from '../utils/format.js';
import { api } from '../api/client.js';
import { store } from '../state/store.js';

class CFSkills extends CFBaseComponent {
    constructor() {
        super();
        this._skills = [];
        this._skillPoints = 0;
        this._isLoading = true;
    }

    _setupSubscriptions() {
        // Subscribe to player currency changes so skill affordability updates
        this.subscribe('player.currency');
    }

    onMount() {
        this._loadSkillTree();

        this.on('click', '.cf-skill-node:not(.cf-skill-node--locked)', async (e) => {
            const skillNode = e.target.closest('.cf-skill-node');
            if (!skillNode) return;
            const skillId = parseInt(skillNode.dataset.skillId, 10);
            await this._unlockSkill(skillId);
        });
    }

    async _loadSkillTree() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._skills.length === 0;

        if (isFirstLoad) {
            this._isLoading = true;
            this.render();
        }

        try {
            const data = await api.getSkillTree();
            this._skills = data.nodes || [];
            this._skillPoints = data.skillPoints || 0;

        } catch (error) {
            console.error('Failed to load skill tree:', error);
        } finally {
            this._isLoading = false;
            this.scheduleRender();
        }
    }

    render() {
        // Use skill points from API response (freshly queried)
        const skillPoints = this._skillPoints;

        this.className = 'cf-skills';

        if (this._isLoading) {
            this.setContent(
                h('div', { class: 'cf-loading' },
                    h('div', { class: 'cf-spinner' })
                )
            );
            return;
        }

        // Group skills by category
        const categories = this._groupByCategory(this._skills);

        this.setContent(
            // Skill points display
            h('div', { class: 'cf-skills__header mb-3' },
                h('span', { class: 'text-sm' }, 'Available Skill Points: '),
                h('span', { class: 'font-bold text-success' }, skillPoints.toString())
            ),

            // Skill categories
            ...Object.entries(categories).map(([category, skills]) =>
                this._renderCategory(category, skills)
            )
        );
    }

    _groupByCategory(skills) {
        return skills.reduce((acc, skill) => {
            const cat = skill.category || 'general';
            if (!acc[cat]) acc[cat] = [];
            acc[cat].push(skill);
            return acc;
        }, {});
    }

    _renderCategory(category, skills) {
        const categoryNames = {
            growth: 'Growth',
            yield: 'Yield',
            quality: 'Quality',
            market: 'Market',
            breeding: 'Breeding',
            general: 'General'
        };

        return h('div', { class: 'cf-skill-category mb-4' },
            h('h3', { class: 'text-sm font-semibold mb-2 text-muted' },
                categoryNames[category] || category
            ),
            h('div', { class: 'cf-skill-tree' },
                ...skills.map(skill => this._renderSkillNode(skill))
            )
        );
    }

    _renderSkillNode(skill) {
        // API returns isUnlocked and currentRank directly on each skill
        const isUnlocked = skill.isUnlocked || skill.currentRank > 0;
        const canUnlock = this._canUnlockSkill(skill);
        const isLocked = !isUnlocked && !canUnlock;

        let statusClass = '';
        if (isUnlocked) statusClass = 'cf-skill-node--unlocked';
        else if (isLocked) statusClass = 'cf-skill-node--locked';

        // Show rank if multi-rank skill
        const rankDisplay = skill.maxRank > 1 && skill.currentRank > 0
            ? ` (${skill.currentRank}/${skill.maxRank})`
            : '';

        return h('div', {
            class: `cf-skill-node ${statusClass}`,
            dataset: { skillId: skill.id?.toString() }
        },
            // Icon
            h('div', { class: 'cf-skill-node__icon' },
                this._renderSkillIcon(skill.category)
            ),

            // Info
            h('div', { class: 'cf-skill-node__info' },
                h('div', { class: 'cf-skill-node__name' }, skill.name + rankDisplay),
                h('div', { class: 'cf-skill-node__description' }, skill.description),
                !isUnlocked && h('div', { class: 'cf-skill-node__cost' },
                    `$${(skill.costCash || 500).toLocaleString()}`
                )
            ),

            // Status indicator
            h('div', { class: 'cf-skill-node__status' },
                isUnlocked ? this._renderCheckIcon() : (
                    isLocked ? this._renderLockIcon() : ''
                )
            )
        );
    }

    _canUnlockSkill(skill) {
        // Already at max rank
        if (skill.currentRank >= skill.maxRank) return false;

        // Check if already unlocked (for multi-rank, check if can upgrade)
        // For single-rank skills that are unlocked, can't unlock again
        if (skill.maxRank === 1 && skill.isUnlocked) return false;

        // Check prerequisites
        if (skill.prerequisites && skill.prerequisites.length > 0) {
            for (const prereqKey of skill.prerequisites) {
                const prereqSkill = this._skills.find(s => s.skillKey === prereqKey);
                if (!prereqSkill || !prereqSkill.isUnlocked) {
                    return false;
                }
            }
        }

        // Check level requirement
        if (skill.requiredLevel && this.getState('player.level') < skill.requiredLevel) {
            return false;
        }

        // Check player has enough cash
        const playerCash = this.getState('player.currency') || 0;
        const cost = skill.costCash || 500;
        return playerCash >= cost;
    }

    async _unlockSkill(skillId) {
        const skill = this._skills.find(s => s.id === skillId);
        if (!skill) return;
        if (skill.maxRank === 1 && skill.isUnlocked) return;
        if (skill.currentRank >= skill.maxRank) return;

        try {
            const result = await api.unlockSkill(skillId);

            // Update player's cash in store immediately for UI responsiveness
            if (result.newCash !== undefined) {
                store.merge('player', { currency: result.newCash });
            }

            this.emit('notification', {
                type: 'success',
                message: `Unlocked: ${skill.name}!`
            });

            // Reload skill tree from server to get fresh state
            // This ensures prerequisites, cash checks, and all skill states are accurate
            await this._loadSkillTree();

        } catch (error) {
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to unlock skill'
            });
        }
    }

    _renderSkillIcon(category) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const icons = {
            growth: 'M12 2v10m0 0c-4 0-7 3-7 7m7-7c4 0 7 3 7 7',
            yield: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
            quality: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
            market: 'M3 3v18h18M7 16l4-4 4 4 5-6',
            breeding: 'M12 4v16m-8-8h16'
        };

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', icons[category] || icons.growth);
        svg.appendChild(path);

        return svg;
    }

    _renderCheckIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'var(--color-success)');
        svg.setAttribute('stroke-width', '3');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M5 13l4 4L19 7');
        svg.appendChild(path);

        return svg;
    }

    _renderLockIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'var(--text-muted)');
        svg.setAttribute('stroke-width', '2');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 17a2 2 0 100-4 2 2 0 000 4zm6-6V9a6 6 0 10-12 0v2m2 10h8a2 2 0 002-2v-6a2 2 0 00-2-2H8a2 2 0 00-2 2v6a2 2 0 002 2z');
        svg.appendChild(path);

        return svg;
    }
}

registerComponent('cf-skills', CFSkills);
export default CFSkills;
