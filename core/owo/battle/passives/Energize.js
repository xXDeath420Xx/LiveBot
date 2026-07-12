/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Energize.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Log from '../util/logUtil.js';

export default class Energize extends PassiveInterface {
	init() {
		this.id = 16;
		this.name = 'Energize';
		this.basicDesc = '';
		this.emojis = [
			'<:cwgen:621558018357854208>',
			'<:uwgen:621558018177368075>',
			'<:rwgen:621558018529689600>',
			'<:ewgen:621558018365980712>',
			'<:mwgen:621558018500329482>',
			'<:lwgen:621558018017853441>',
			'<:fwgen:621558018424700948>',
		];
		this.statDesc = `Replenish **?** ${WeaponInterface.wpEmoji}WP after every turn`;
		this.qualityList = [[20, 40]];
	}

	postTurn(animal, ally, enemy, _action) {
		if (animal.stats.hp[0] <= 0) return;

		if (animal.stats.wp[0] >= animal.stats.wp[1] + animal.stats.wp[3]) return;

		let logs = new Log();
		let replenish = this.stats[0];
		replenish = WeaponInterface.replenish(animal, replenish, animal, {
			me: animal,
			allies: ally,
			enemies: enemy,
		});
		logs.push(`[ENERG] ${animal.nickname} replenished ${replenish.amount} WP`, replenish.logs);

		return logs;
	}
};
