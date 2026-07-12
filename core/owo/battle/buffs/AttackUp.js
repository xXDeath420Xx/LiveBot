/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/buffs/AttackUp.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import BuffInterface from '../BuffInterface.js';
import Logs from '../util/logUtil.js';

export default class AttackUp extends BuffInterface {
	init() {
		this.id = 6;
		this.name = 'Attack Up';
		this.debuff = false;
		this.emoji = '<:attup:618734436506140675>';
		this.statDesc = 'Increases all damage by **?%**. Cannot stack with other Attack Up buffs';
		this.qualityList = [[15, 25]];
	}

	// Override
	bind(animal, duration, tags) {
		for (let i in animal.buffs) {
			if (animal.buffs[i].id == this.id) {
				animal.buffs[i].duration += duration;
				this.justCreated = true;
				return;
			}
		}

		super.bind(animal, duration, tags);
	}

	attack(animal, attackee, damage, _type, _last) {
		if (this.markedForDeath) return;
		let logs = new Logs();

		let bonus = damage[0] * (this.stats[0] / 100);
		damage[1] += bonus;

		logs.push(`[ATTUP] ${animal.nickname} dealt ${Math.round(bonus)} bonus damage`);
		return logs;
	}
};
