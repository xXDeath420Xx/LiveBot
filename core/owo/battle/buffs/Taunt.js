/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/buffs/Taunt.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import BuffInterface from '../BuffInterface.js';
import Logs from '../util/logUtil.js';

export default class Taunt extends BuffInterface {
	init() {
		this.id = 1;
		this.name = 'Taunt';
		this.debuff = false;
		this.emoji = '<:taunt:546615322598440960>';
		this.statDesc =
			'Taunts the enemy team and forces all opponents to attack this animal. Reduces incoming damage by **?**%';
		this.qualityList = [[30, 50]];
	}

	enemyChooseAttack(animal, _attacker, _ally, _enemy) {
		if (animal.stats.hp[0] > 0) return animal;
	}

	attacked(animal, attacker, damage, _type, _last) {
		let logs = new Logs();

		let negate = ((damage[0] + damage[1]) * this.stats[0]) / 100;
		damage[1] -= negate;

		logs.push(`[TAUNT] ${animal.nickname} negated ${Math.round(negate)} damage`);
		return logs;
	}
};
