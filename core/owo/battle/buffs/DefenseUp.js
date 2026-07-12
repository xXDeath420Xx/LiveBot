/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/buffs/DefenseUp.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import BuffInterface from '../BuffInterface.js';
import Logs from '../util/logUtil.js';

export default class defenseUp extends BuffInterface {
	init() {
		this.id = 4;
		this.name = 'Defense Up';
		this.debuff = false;
		this.emoji = '<:dfup:572988965838258176>';
		this.statDesc = 'Reduces incoming damage by **?%**. Cannot stack with other Defense Up buffs';
		this.qualityList = [[20, 30]];
	}

	// Override
	bind(animal, duration, tags) {
		for (let i in animal.buffs) {
			if (animal.buffs[i].id == this.id) {
				animal.buffs[i].duration += duration;
				return;
			}
		}

		super.bind(animal, duration, tags);
	}

	attacked(animal, attacker, damage, _type, _last) {
		let logs = new Logs();

		let negate = ((damage[0] + damage[1]) * this.stats[0]) / 100;
		damage[1] -= negate;

		logs.push(`[DFUP] ${animal.nickname} negated ${Math.round(negate)} damage`);
		return logs;
	}
};
