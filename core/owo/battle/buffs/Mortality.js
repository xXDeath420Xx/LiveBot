/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/buffs/Mortality.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import BuffInterface from '../BuffInterface.js';
import Logs from '../util/logUtil.js';

export default class Mortality extends BuffInterface {
	init() {
		this.id = 9;
		this.name = 'Mortality';
		this.debuff = true;
		this.emoji = '<:mortality:619458869730476042>';
		this.statDesc = 'Decreases all healing for this animal by **?%**';
		this.qualityList = [[45, 75]];
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

	healed(animal, healer, amount, _tag) {
		let logs = new Logs();

		let dec = amount[0] * (this.stats[0] / 100);
		amount[1] -= dec;

		logs.push(`[MORT] Healing was decreased by ${Math.round(dec)}`);
		return logs;
	}
};
