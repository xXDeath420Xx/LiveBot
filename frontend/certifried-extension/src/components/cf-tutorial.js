/**
 * CertiFried Extension - Tutorial Component
 * New player onboarding flow
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';

const TUTORIAL_STEPS = [
    {
        title: 'Welcome to CertiFried!',
        description: 'Your journey to becoming the ultimate cannabis tycoon starts here. Let\'s learn the basics!',
        icon: 'welcome'
    },
    {
        title: 'Plant Seeds',
        description: 'Click an empty plot to plant a seed. Each strain has different grow times, yields, and rarity.',
        icon: 'plant'
    },
    {
        title: 'Harvest & Sell',
        description: 'When your plants are ready, harvest them! Sell on the market or use them for breeding new strains.',
        icon: 'harvest'
    },
    {
        title: 'Level Up',
        description: 'Gain XP by harvesting, selling, and completing quests. Higher levels unlock more plots and strains!',
        icon: 'level'
    },
    {
        title: 'Breed New Strains',
        description: 'Combine two strains to create new genetics. Discover rare and legendary strains!',
        icon: 'breed'
    },
    {
        title: 'Ready to Grow!',
        description: 'You\'re all set! Start planting and build your cannabis empire. Good luck!',
        icon: 'ready'
    }
];

class CFTutorial extends CFBaseComponent {
    constructor() {
        super();
        this._currentStep = 0;
        this._isComplete = false;
    }

    static get observedAttributes() {
        return ['open'];
    }

    onMount() {
        // Check if tutorial was completed
        this._isComplete = localStorage.getItem('cfx_tutorial_complete') === 'true';

        // Auto-show for new players
        const player = this.getState('player');
        if (player && player.level === 1 && !this._isComplete) {
            this.setAttribute('open', '');
        }

        this.on('click', '.cf-tutorial__next', () => this._nextStep());
        this.on('click', '.cf-tutorial__skip', () => this._complete());
        this.on('click', '.cf-tutorial__finish', () => this._complete());
    }

    render() {
        const isOpen = this.hasAttribute('open');

        if (!isOpen) {
            this.style.display = 'none';
            this.setContent();
            return;
        }

        this.className = 'cf-modal-backdrop';
        this.style.display = 'flex';

        const step = TUTORIAL_STEPS[this._currentStep];
        const isLastStep = this._currentStep === TUTORIAL_STEPS.length - 1;

        this.setContent(
            h('div', { class: 'cf-modal cf-tutorial-modal' },
                // Progress dots
                h('div', {
                    class: 'cf-tutorial__progress',
                    style: {
                        display: 'flex',
                        justifyContent: 'center',
                        gap: 'var(--space-2)',
                        padding: 'var(--space-3)',
                        borderBottom: '1px solid var(--border-primary)'
                    }
                },
                    ...TUTORIAL_STEPS.map((_, i) => h('div', {
                        style: {
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: i === this._currentStep
                                ? 'var(--color-primary-500)'
                                : i < this._currentStep
                                    ? 'var(--color-primary-600)'
                                    : 'var(--bg-tertiary)'
                        }
                    }))
                ),

                // Content
                h('div', { class: 'cf-modal__body text-center' },
                    // Icon
                    h('div', {
                        style: {
                            width: '80px',
                            height: '80px',
                            margin: '0 auto var(--space-4)',
                            background: 'var(--bg-tertiary)',
                            borderRadius: 'var(--radius-xl)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }
                    }, this._renderIcon(step.icon)),

                    // Title
                    h('h2', {
                        class: 'cf-tutorial__title',
                        style: {
                            fontSize: 'var(--font-size-xl)',
                            fontWeight: 'var(--font-weight-bold)',
                            marginBottom: 'var(--space-3)',
                            color: 'var(--color-primary-400)'
                        }
                    }, step.title),

                    // Description
                    h('p', {
                        class: 'cf-tutorial__description',
                        style: {
                            color: 'var(--text-secondary)',
                            marginBottom: 'var(--space-4)',
                            lineHeight: 'var(--line-height-relaxed)'
                        }
                    }, step.description)
                ),

                // Actions
                h('div', {
                    class: 'cf-modal__footer',
                    style: { justifyContent: 'space-between' }
                },
                    h('button', {
                        class: 'cf-tutorial__skip cf-btn cf-btn--ghost'
                    }, 'Skip'),

                    isLastStep
                        ? h('button', {
                            class: 'cf-tutorial__finish cf-btn cf-btn--primary'
                        }, 'Start Growing!')
                        : h('button', {
                            class: 'cf-tutorial__next cf-btn cf-btn--primary'
                        }, 'Next')
                )
            )
        );
    }

    _nextStep() {
        if (this._currentStep < TUTORIAL_STEPS.length - 1) {
            this._currentStep++;
            this.render();
        }
    }

    _complete() {
        this._isComplete = true;
        localStorage.setItem('cfx_tutorial_complete', 'true');
        this.removeAttribute('open');

        this.emit('tutorial-complete');
    }

    // Public API to show tutorial
    show() {
        this._currentStep = 0;
        this.setAttribute('open', '');
    }

    _renderIcon(type) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '48');
        svg.setAttribute('height', '48');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'var(--color-primary-400)');
        svg.setAttribute('stroke-width', '1.5');

        const icons = {
            welcome: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
            plant: 'M12 2v10m0 0c-4 0-7 3-7 7m7-7c4 0 7 3 7 7M7 19v2m10-2v2',
            harvest: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
            level: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
            breed: 'M12 4v16m-8-8h16',
            ready: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'
        };

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', icons[type] || icons.welcome);
        svg.appendChild(path);

        return svg;
    }
}

registerComponent('cf-tutorial', CFTutorial);
export default CFTutorial;
