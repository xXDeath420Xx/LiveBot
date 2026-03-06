/**
 * CertiFried Extension - Minigames Component
 * Fully functional skill-based mini-games for rewards
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatNumber } from '../utils/format.js';
import { api } from '../api/client.js';

// Game implementations
const GAME_IMPLEMENTATIONS = {
    // Reaction Time Game - Click when green
    reaction_time: {
        init(component) {
            component._reactionState = 'waiting'; // waiting, ready, clicked, toosoon
            component._reactionStartTime = null;
            component._reactionTimes = [];
            component._reactionRound = 0;
            component._reactionMaxRounds = 5;
        },
        start(component) {
            component._reactionRound = 0;
            component._reactionTimes = [];
            component._gameScore = 0;
            this.nextRound(component);
        },
        nextRound(component) {
            if (component._reactionRound >= component._reactionMaxRounds) {
                // Game over - calculate final score
                const avgTime = component._reactionTimes.reduce((a, b) => a + b, 0) / component._reactionTimes.length;
                // Score: 1000 - avg reaction time (lower is better), min 0
                component._gameScore = Math.max(0, Math.floor(1000 - avgTime));
                component._gameState = 'finished';
                component._submitScore();
                return;
            }
            component._reactionState = 'waiting';
            component.render();
            // Random delay 1-4 seconds before showing green
            const delay = 1000 + Math.random() * 3000;
            component._reactionTimeout = setTimeout(() => {
                component._reactionState = 'ready';
                component._reactionStartTime = Date.now();
                component.render();
            }, delay);
        },
        handleClick(component) {
            if (component._reactionState === 'waiting') {
                // Clicked too soon
                clearTimeout(component._reactionTimeout);
                component._reactionState = 'toosoon';
                component.render();
                setTimeout(() => this.nextRound(component), 1500);
            } else if (component._reactionState === 'ready') {
                // Good click - record time
                const reactionTime = Date.now() - component._reactionStartTime;
                component._reactionTimes.push(reactionTime);
                component._reactionRound++;
                component._reactionState = 'clicked';
                component._lastReactionTime = reactionTime;
                component.render();
                setTimeout(() => this.nextRound(component), 1000);
            }
        },
        render(component) {
            const state = component._reactionState;
            const round = component._reactionRound + 1;
            const maxRounds = component._reactionMaxRounds;

            let bgColor = 'var(--color-danger)'; // Red - wait
            let text = 'Wait for GREEN...';
            let clickable = true;

            if (state === 'ready') {
                bgColor = 'var(--color-success)';
                text = 'CLICK NOW!';
            } else if (state === 'toosoon') {
                bgColor = 'var(--color-warning)';
                text = 'Too soon! Wait for green.';
                clickable = false;
            } else if (state === 'clicked') {
                bgColor = 'var(--bg-tertiary)';
                text = `${component._lastReactionTime}ms`;
                clickable = false;
            }

            return h('div', { class: 'cf-game-reaction' },
                h('div', { class: 'text-center mb-3' },
                    h('span', { class: 'text-sm text-muted' }, `Round ${round}/${maxRounds}`),
                    component._reactionTimes.length > 0 && h('span', { class: 'text-sm ml-3' },
                        `Avg: ${Math.round(component._reactionTimes.reduce((a,b)=>a+b,0)/component._reactionTimes.length)}ms`
                    )
                ),
                h('div', {
                    class: 'cf-reaction-area',
                    style: {
                        background: bgColor,
                        borderRadius: 'var(--radius-lg)',
                        padding: 'var(--space-8)',
                        textAlign: 'center',
                        cursor: clickable ? 'pointer' : 'default',
                        transition: 'background 0.1s',
                        minHeight: '200px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    },
                    onclick: clickable ? () => this.handleClick(component) : null
                },
                    h('div', {},
                        h('div', { class: 'text-2xl font-bold', style: { color: '#fff' } }, text),
                        state === 'clicked' && h('div', { class: 'text-sm mt-2', style: { color: '#fff' } }, 'Nice!')
                    )
                )
            );
        },
        cleanup(component) {
            if (component._reactionTimeout) clearTimeout(component._reactionTimeout);
        }
    },

    // Memory Match Game - Match pairs
    memory_match: {
        init(component) {
            component._memoryCards = [];
            component._memoryFlipped = [];
            component._memoryMatched = [];
            component._memoryMoves = 0;
            component._memoryStartTime = null;
        },
        start(component) {
            // Create pairs of cards (emojis)
            const symbols = ['🌿', '💰', '🔥', '⚡', '💎', '🎯', '🌟', '🎪'];
            const cards = [...symbols, ...symbols];
            // Shuffle
            for (let i = cards.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [cards[i], cards[j]] = [cards[j], cards[i]];
            }
            component._memoryCards = cards;
            component._memoryFlipped = [];
            component._memoryMatched = [];
            component._memoryMoves = 0;
            component._memoryStartTime = Date.now();
            component._gameScore = 0;
            component.render();
        },
        handleCardClick(component, index) {
            // Can't click if already flipped or matched
            if (component._memoryFlipped.includes(index) || component._memoryMatched.includes(index)) return;
            // Can't click if two cards already flipped
            if (component._memoryFlipped.length >= 2) return;

            component._memoryFlipped.push(index);
            component.render();

            if (component._memoryFlipped.length === 2) {
                component._memoryMoves++;
                const [first, second] = component._memoryFlipped;

                if (component._memoryCards[first] === component._memoryCards[second]) {
                    // Match!
                    component._memoryMatched.push(first, second);
                    component._memoryFlipped = [];

                    // Check win
                    if (component._memoryMatched.length === component._memoryCards.length) {
                        const timeTaken = (Date.now() - component._memoryStartTime) / 1000;
                        // Score: base 1000 - (moves * 20) - (time * 5), min 100
                        component._gameScore = Math.max(100, Math.floor(1000 - (component._memoryMoves * 20) - (timeTaken * 5)));
                        component._gameState = 'finished';
                        component._submitScore();
                    }
                    component.render();
                } else {
                    // No match - flip back after delay
                    setTimeout(() => {
                        component._memoryFlipped = [];
                        component.render();
                    }, 1000);
                }
            }
        },
        render(component) {
            return h('div', { class: 'cf-game-memory' },
                h('div', { class: 'text-center mb-3' },
                    h('span', { class: 'text-sm' }, `Moves: ${component._memoryMoves}`),
                    h('span', { class: 'text-sm ml-3' }, `Matched: ${component._memoryMatched.length / 2}/8`)
                ),
                h('div', {
                    style: {
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, 1fr)',
                        gap: 'var(--space-2)',
                        maxWidth: '300px',
                        margin: '0 auto'
                    }
                },
                    ...component._memoryCards.map((symbol, idx) => {
                        const isFlipped = component._memoryFlipped.includes(idx);
                        const isMatched = component._memoryMatched.includes(idx);
                        const showSymbol = isFlipped || isMatched;

                        return h('div', {
                            style: {
                                aspectRatio: '1',
                                background: isMatched ? 'var(--color-success)' : (showSymbol ? 'var(--bg-tertiary)' : 'var(--color-primary)'),
                                borderRadius: 'var(--radius-md)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '24px',
                                cursor: showSymbol ? 'default' : 'pointer',
                                transition: 'all 0.2s'
                            },
                            onclick: () => this.handleCardClick(component, idx)
                        }, showSymbol ? symbol : '?');
                    })
                )
            );
        },
        cleanup() {}
    },

    // Quick Math Game - Solve equations fast
    quick_math: {
        init(component) {
            component._mathProblem = null;
            component._mathAnswer = '';
            component._mathScore = 0;
            component._mathRound = 0;
            component._mathMaxRounds = 10;
            component._mathTimeLeft = 0;
            component._mathCorrect = 0;
        },
        start(component) {
            component._mathRound = 0;
            component._mathScore = 0;
            component._mathCorrect = 0;
            component._mathTimeLeft = 60; // 60 seconds total
            this.generateProblem(component);
            component._mathTimer = setInterval(() => {
                component._mathTimeLeft--;
                if (component._mathTimeLeft <= 0) {
                    this.endGame(component);
                }
                component.render();
            }, 1000);
        },
        generateProblem(component) {
            const ops = ['+', '-', '*'];
            const op = ops[Math.floor(Math.random() * ops.length)];
            let a, b, answer;

            if (op === '+') {
                a = Math.floor(Math.random() * 50) + 1;
                b = Math.floor(Math.random() * 50) + 1;
                answer = a + b;
            } else if (op === '-') {
                a = Math.floor(Math.random() * 50) + 10;
                b = Math.floor(Math.random() * a);
                answer = a - b;
            } else {
                a = Math.floor(Math.random() * 12) + 1;
                b = Math.floor(Math.random() * 12) + 1;
                answer = a * b;
            }

            component._mathProblem = { a, b, op, answer };
            component._mathAnswer = '';
            component._mathRound++;
            component.render();
        },
        submitAnswer(component) {
            const userAnswer = parseInt(component._mathAnswer, 10);
            if (userAnswer === component._mathProblem.answer) {
                component._mathCorrect++;
                component._mathScore += Math.max(10, 50 - component._mathRound); // More points early
            }
            this.generateProblem(component);
        },
        endGame(component) {
            clearInterval(component._mathTimer);
            component._gameScore = component._mathScore + (component._mathCorrect * 20);
            component._gameState = 'finished';
            component._submitScore();
        },
        render(component) {
            const problem = component._mathProblem;
            if (!problem) return h('div', {}, 'Loading...');

            return h('div', { class: 'cf-game-math' },
                h('div', { class: 'text-center mb-3', style: { display: 'flex', justifyContent: 'space-between' } },
                    h('span', { class: 'text-sm' }, `⏱️ ${component._mathTimeLeft}s`),
                    h('span', { class: 'text-sm' }, `✅ ${component._mathCorrect} correct`),
                    h('span', { class: 'text-sm' }, `🏆 ${component._mathScore} pts`)
                ),
                h('div', {
                    style: {
                        background: 'var(--bg-tertiary)',
                        borderRadius: 'var(--radius-lg)',
                        padding: 'var(--space-4)',
                        textAlign: 'center'
                    }
                },
                    h('div', { class: 'text-3xl font-bold mb-4' },
                        `${problem.a} ${problem.op} ${problem.b} = ?`
                    ),
                    h('input', {
                        type: 'number',
                        class: 'cf-input',
                        style: {
                            fontSize: '24px',
                            textAlign: 'center',
                            width: '150px',
                            margin: '0 auto',
                            display: 'block'
                        },
                        value: component._mathAnswer,
                        oninput: (e) => {
                            component._mathAnswer = e.target.value;
                        },
                        onkeydown: (e) => {
                            if (e.key === 'Enter') {
                                this.submitAnswer(component);
                            }
                        },
                        autofocus: true
                    }),
                    h('button', {
                        class: 'cf-btn cf-btn--primary mt-3',
                        onclick: () => this.submitAnswer(component)
                    }, 'Submit')
                )
            );
        },
        cleanup(component) {
            if (component._mathTimer) clearInterval(component._mathTimer);
        }
    },

    // Sequence Game - Remember and repeat pattern
    sequence_memory: {
        init(component) {
            component._seqPattern = [];
            component._seqPlayerInput = [];
            component._seqShowingPattern = false;
            component._seqCurrentShow = -1;
            component._seqLevel = 0;
        },
        start(component) {
            component._seqPattern = [];
            component._seqLevel = 0;
            component._gameScore = 0;
            this.addToPattern(component);
        },
        addToPattern(component) {
            component._seqLevel++;
            component._seqPattern.push(Math.floor(Math.random() * 4));
            component._seqPlayerInput = [];
            this.showPattern(component);
        },
        showPattern(component) {
            component._seqShowingPattern = true;
            component._seqCurrentShow = -1;
            component.render();

            let i = 0;
            const showNext = () => {
                if (i < component._seqPattern.length) {
                    component._seqCurrentShow = component._seqPattern[i];
                    component.render();
                    setTimeout(() => {
                        component._seqCurrentShow = -1;
                        component.render();
                        i++;
                        setTimeout(showNext, 300);
                    }, 600);
                } else {
                    component._seqShowingPattern = false;
                    component.render();
                }
            };
            setTimeout(showNext, 500);
        },
        handleButtonClick(component, btnIndex) {
            if (component._seqShowingPattern) return;

            component._seqPlayerInput.push(btnIndex);
            const inputIdx = component._seqPlayerInput.length - 1;

            // Flash the button
            component._seqCurrentShow = btnIndex;
            component.render();
            setTimeout(() => {
                component._seqCurrentShow = -1;
                component.render();
            }, 200);

            if (component._seqPlayerInput[inputIdx] !== component._seqPattern[inputIdx]) {
                // Wrong! Game over
                component._gameScore = (component._seqLevel - 1) * 100;
                component._gameState = 'finished';
                component._submitScore();
                return;
            }

            if (component._seqPlayerInput.length === component._seqPattern.length) {
                // Level complete!
                setTimeout(() => this.addToPattern(component), 1000);
            }
        },
        render(component) {
            const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];
            const showing = component._seqCurrentShow;

            return h('div', { class: 'cf-game-sequence' },
                h('div', { class: 'text-center mb-3' },
                    h('span', { class: 'text-lg font-bold' }, `Level ${component._seqLevel}`),
                    component._seqShowingPattern && h('div', { class: 'text-sm text-muted' }, 'Watch the pattern...')
                ),
                h('div', {
                    style: {
                        display: 'grid',
                        gridTemplateColumns: 'repeat(2, 1fr)',
                        gap: 'var(--space-3)',
                        maxWidth: '250px',
                        margin: '0 auto'
                    }
                },
                    ...colors.map((color, idx) => h('div', {
                        style: {
                            aspectRatio: '1',
                            background: color,
                            borderRadius: 'var(--radius-lg)',
                            opacity: showing === idx ? 1 : 0.5,
                            cursor: component._seqShowingPattern ? 'default' : 'pointer',
                            transition: 'opacity 0.1s',
                            boxShadow: showing === idx ? `0 0 20px ${color}` : 'none'
                        },
                        onclick: () => this.handleButtonClick(component, idx)
                    }))
                ),
                !component._seqShowingPattern && h('div', { class: 'text-center mt-3 text-sm text-muted' },
                    `Your turn! ${component._seqPlayerInput.length}/${component._seqPattern.length}`
                )
            );
        },
        cleanup() {}
    }
};

class CFMinigames extends CFBaseComponent {
    constructor() {
        super();
        this._minigamesData = null;
        this._loading = true;
        this._activeGame = null;
        this._sessionToken = null;
        this._gameScore = 0;
        this._gameState = 'idle'; // idle, playing, finished
        this._showLeaderboard = false;
        this._leaderboardData = null;
    }

    _setupSubscriptions() {
        this.subscribe('player');
    }

    async onMount() {
        await this._loadData();

        // Play minigame
        this.on('click', '.cf-minigame-play', async (e) => {
            const btn = e.target.closest('.cf-minigame-play');
            const gameKey = btn.dataset.gameKey;

            try {
                btn.disabled = true;
                btn.textContent = 'Starting...';

                const result = await api.startMinigame(gameKey);
                if (result.success) {
                    this._activeGame = result.game;
                    this._sessionToken = result.sessionToken;
                    this._gameScore = 0;
                    this._gameState = 'playing';

                    // Initialize game-specific state
                    const impl = GAME_IMPLEMENTATIONS[gameKey];
                    if (impl) {
                        impl.init(this);
                        impl.start(this);
                    }

                    this.render();
                }
            } catch (error) {
                this.emit('notification', { type: 'error', message: error.message });
                btn.disabled = false;
                btn.textContent = 'Play';
            }
        });

        // Back to list
        this.on('click', '.cf-minigame-back', async () => {
            // Cleanup any running game
            if (this._activeGame) {
                const impl = GAME_IMPLEMENTATIONS[this._activeGame.key];
                if (impl?.cleanup) impl.cleanup(this);
            }
            this._activeGame = null;
            this._sessionToken = null;
            this._gameState = 'idle';
            await this._loadData();
        });

        // Show leaderboard
        this.on('click', '.cf-minigame-leaderboard', async (e) => {
            const btn = e.target.closest('.cf-minigame-leaderboard');
            const gameKey = btn.dataset.gameKey;

            try {
                this._leaderboardData = await api.getMinigameLeaderboard(gameKey);
                this._showLeaderboard = true;
                this.render();
            } catch (error) {
                this.emit('notification', { type: 'error', message: error.message });
            }
        });

        // Close leaderboard
        this.on('click', '.cf-leaderboard-close', () => {
            this._showLeaderboard = false;
            this.render();
        });
    }

    async _submitScore() {
        if (!this._activeGame || !this._sessionToken) return;

        try {
            const result = await api.submitMinigameScore(
                this._activeGame.key,
                this._gameScore,
                this._sessionToken
            );

            if (result.success) {
                this.emit('notification', {
                    type: 'success',
                    message: result.message || `Score: ${this._gameScore}! ${result.rewardDisplay || ''}`
                });
            }
        } catch (error) {
            this.emit('notification', { type: 'error', message: error.message });
        }
        this.render();
    }

    async _loadData() {
        const isFirstLoad = !this._minigamesData;

        if (isFirstLoad) {
            this._loading = true;
            this.render();
        }

        try {
            this._minigamesData = await api.getMinigames();
        } catch (error) {
            console.error('[CFMinigames] Load error:', error);
        } finally {
            this._loading = false;
            this.scheduleRender();
        }
    }

    render() {
        this.className = 'cf-minigames';

        if (this._loading) {
            this.setContent(
                h('div', { class: 'cf-loading' },
                    h('div', { class: 'cf-spinner' }),
                    h('p', {}, 'Loading minigames...')
                )
            );
            return;
        }

        if (this._showLeaderboard) {
            this.setContent(this._renderLeaderboardModal());
            return;
        }

        if (this._activeGame) {
            this.setContent(this._renderActiveGame());
            return;
        }

        if (!this._minigamesData) {
            this.setContent(h('div', { class: 'cf-error' }, 'Failed to load minigames'));
            return;
        }

        const { minigames, playerLevel } = this._minigamesData;

        this.setContent(
            h('div', { class: 'cf-minigames__header', style: { marginBottom: 'var(--space-4)' } },
                h('h2', { class: 'cf-section__title' }, '🎮 Minigames'),
                h('p', { class: 'text-sm text-muted' }, 'Play skill-based games to earn cash rewards!')
            ),

            minigames.length === 0
                ? h('div', { class: 'cf-empty text-center py-8' },
                    h('p', { class: 'text-muted' }, 'No minigames available')
                )
                : h('div', { class: 'cf-minigames-list' },
                    ...minigames.map(game => this._renderGameCard(game, playerLevel))
                )
        );
    }

    _renderGameCard(game, playerLevel) {
        const isLocked = !game.isUnlocked;
        const onCooldown = game.cooldownEnds !== null;
        const hasImpl = !!GAME_IMPLEMENTATIONS[game.key];

        return h('div', {
            class: `cf-card mb-3 ${isLocked ? 'cf-locked' : ''}`,
            style: { opacity: isLocked ? 0.6 : 1 }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', gap: 'var(--space-3)' } },
                    h('div', {
                        style: {
                            width: '50px', height: '50px',
                            background: 'var(--bg-tertiary)',
                            borderRadius: 'var(--radius-md)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '24px'
                        }
                    }, game.icon || '🎮'),

                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' }, game.name),
                        h('div', { class: 'text-xs text-muted mb-2' }, game.description),

                        h('div', { style: { display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' } },
                            h('span', { class: 'text-xs' }, `🏆 Best: ${formatNumber(game.highScore)}`),
                            h('span', { class: 'text-xs' }, `🎯 Plays: ${game.playCount}`),
                            h('span', { class: 'text-xs', style: { color: 'var(--color-success)' } },
                                `💰 ${this._getRewardDisplay(game)}`
                            )
                        ),

                        isLocked && h('div', { class: 'text-xs mt-2', style: { color: 'var(--color-warning)' } },
                            `🔒 Requires level ${game.minLevel}`
                        ),
                        onCooldown && h('div', { class: 'text-xs mt-2', style: { color: 'var(--color-warning)' } },
                            `⏳ Available ${this._formatCooldown(game.cooldownEnds)}`
                        )
                    ),

                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' } },
                        h('button', {
                            class: 'cf-btn cf-btn--primary cf-btn--sm cf-minigame-play',
                            dataset: { gameKey: game.key },
                            disabled: !game.canPlay || !hasImpl
                        }, game.canPlay ? (hasImpl ? 'Play' : 'Soon') : (isLocked ? 'Locked' : 'Wait')),
                        h('button', {
                            class: 'cf-btn cf-btn--ghost cf-btn--sm cf-minigame-leaderboard',
                            dataset: { gameKey: game.key }
                        }, 'Ranks')
                    )
                )
            )
        );
    }

    _renderActiveGame() {
        const game = this._activeGame;
        const impl = GAME_IMPLEMENTATIONS[game.key];

        return h('div', { class: 'cf-minigame-active' },
            h('button', {
                class: 'cf-btn cf-btn--ghost mb-3 cf-minigame-back',
                style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }
            },
                h('span', {}, '←'),
                h('span', {}, 'Back')
            ),

            h('div', { class: 'cf-card mb-4' },
                h('div', { class: 'cf-card__body text-center' },
                    h('h2', { class: 'cf-section__title' }, game.name),
                    h('p', { class: 'text-sm text-muted' }, game.instructions || 'Score as high as you can!')
                )
            ),

            // Render actual game or finished state
            this._gameState === 'playing' && impl
                ? h('div', { class: 'cf-game-container', style: { marginBottom: 'var(--space-4)' } },
                    impl.render(this)
                )
                : null,

            // Finished state
            this._gameState === 'finished' && h('div', {
                class: 'cf-card',
                style: { textAlign: 'center', padding: 'var(--space-4)' }
            },
                h('div', { style: { fontSize: '48px', marginBottom: 'var(--space-2)' } }, '🎉'),
                h('h3', { class: 'font-semibold mb-2' }, 'Game Complete!'),
                h('div', { class: 'text-2xl font-bold mb-2', style: { color: 'var(--color-success)' } },
                    `Score: ${this._gameScore}`
                ),
                h('button', {
                    class: 'cf-btn cf-btn--primary mt-3 cf-minigame-back'
                }, 'Back to Games')
            )
        );
    }

    _renderLeaderboardModal() {
        const lb = this._leaderboardData?.leaderboard || [];

        return h('div', {
            class: 'cf-leaderboard-view',
            style: { maxHeight: '80vh', overflow: 'auto' }
        },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3)' } },
                h('h2', { class: 'cf-section__title' }, 'Leaderboard'),
                h('button', { class: 'cf-btn cf-btn--ghost cf-leaderboard-close' }, '✕')
            ),

            lb.length === 0
                ? h('div', { class: 'cf-empty text-center py-8' },
                    h('p', { class: 'text-muted' }, 'No scores yet. Be the first!')
                )
                : h('div', { class: 'cf-leaderboard-list' },
                    ...lb.map((entry, idx) => this._renderLeaderboardEntry(entry, idx))
                )
        );
    }

    _renderLeaderboardEntry(entry, index) {
        const medals = ['🥇', '🥈', '🥉'];
        const medal = medals[index] || `#${entry.rank}`;

        return h('div', {
            class: 'cf-card mb-2',
            style: { background: index < 3 ? 'var(--bg-tertiary)' : 'var(--bg-secondary)' }
        },
            h('div', {
                class: 'cf-card__body',
                style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }
            },
                h('div', { style: { fontSize: '20px', width: '30px', textAlign: 'center' } }, medal),
                h('div', { style: { flex: 1 } },
                    h('div', { class: 'font-semibold' }, entry.displayName),
                    h('div', { class: 'text-xs text-muted' }, `Level ${entry.level} • ${entry.playCount} plays`)
                ),
                h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-success)' } },
                    formatNumber(entry.highScore)
                )
            )
        );
    }

    _getRewardDisplay(game) {
        switch (game.rewardType) {
            case 'cash':
                return `Up to ${formatCurrency(game.baseRewardValue)}`;
            case 'xp':
                return `Up to ${game.baseRewardValue} XP`;
            default:
                return `${game.rewardType} reward`;
        }
    }

    _formatCooldown(cooldownEnds) {
        if (!cooldownEnds) return '';
        const now = new Date();
        const end = new Date(cooldownEnds);
        const diffMs = end - now;

        if (diffMs <= 0) return 'now';

        const minutes = Math.floor(diffMs / 60000);
        if (minutes < 60) return `in ${minutes}m`;

        const hours = Math.floor(minutes / 60);
        return `in ${hours}h`;
    }
}

registerComponent('cf-minigames', CFMinigames);
export default CFMinigames;
