/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/buffs/Freeze.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import BuffInterface from '../BuffInterface.js';
import Logs from '../util/logUtil.js';

export default class Freeze extends BuffInterface {
	init() {
		this.id = 5;
		this.name = 'Freeze';
		this.debuff = true;
		this.emoji = '<:freeze:618621661486514176>';
		this.statDesc = 'Freeze an enemy. They can not attack next turn.';
		this.qualityList = [];
	}

	canAttack(me, ally, enemy, action, result) {
		// Freeze only works next turn
		if (this.justCreated) return;

		result.result = false;
		super.postTurn(me, ally, enemy, action);

		let logs = new Logs();
		logs.push(`[FREEZE] ${me.nickname} is frozen and can't attack`);
		return logs;
	}

	// Skip duration decrementation, because we will do that in canAttack
	postTurn(_animal, _ally, _enemy, _action) {
		if (this.justCreated) this.justCreated = false;
	}
};
