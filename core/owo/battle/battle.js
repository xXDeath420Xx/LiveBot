/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/battle.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import CommandInterface from '../../CommandInterface.js';

import battleFriendUtil from './util/battleFriendUtil.js';
import BattleEvent from './util/BattleEvent.js';

export default new CommandInterface({
	alias: ['battle', 'b', 'fight'],

	args: '',

	desc: '',

	example: [''],

	related: ['owo zoo', 'owo pet', 'owo team', 'owo weapon'],

	permissions: ['sendMessages', 'embedLinks', 'addReactions'],

	group: ['animals'],

	appCommands: [
		{
			'name': 'battle',
			'type': 1,
			'description': 'Fight with your team of animals!',
			'options': [
				{
					'type': 6,
					'name': 'user',
					'description': 'Fight a friend.',
				},
			],
			'integration_types': [0, 1],
			'contexts': [0],
		},
	],

	cooldown: 15000,
	half: 80,
	six: 500,
	bot: true,

	execute: async function () {
		/* If its a friendly battle... */
		if (await isFriendlyBattle.bind(this)()) {
			return;
		}

		const battleEvent = new BattleEvent(this);
		await battleEvent.init();
		battleEvent.simulateBattle();
		await battleEvent.distributeRewards();
		await battleEvent.displayBattles();
	},
});

async function isFriendlyBattle() {
	if (this.global.isUser(this.args[0])) {
		let id = this.args[0].match(/[0-9]+/)[0];
		let opponent = this.msg.mentions[0];
		if (!opponent) {
			this.errorMsg(', That is not a valid id!');
			return true;
		}
		if (!id) {
			await this.errorMsg(', The correct command is `owo battle @user`!', 3000);
		} else if (id == this.msg.author.id) {
			battleFriendUtil.challenge(this, this.msg.author);
		} else {
			battleFriendUtil.challenge(this, opponent, 0);
		}
		return true;
	} else if (this.options.user) {
		if (this.options.user.id == this.msg.author.id) {
			battleFriendUtil.challenge(this, this.msg.author);
		} else {
			battleFriendUtil.challenge(this, this.options.user);
		}
		return true;
	}
	return false;
}
