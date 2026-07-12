/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/buffs/Poison.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import BuffInterface from '../BuffInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Logs from '../util/logUtil.js';

export default class Poison extends BuffInterface {
	init() {
		this.id = 2;
		this.name = 'Poison';
		this.debuff = true;
		this.emoji = '<:poison:572311805704273920>';
		this.statDesc =
			'Deals **?%** of your ' +
			WeaponInterface.magEmoji +
			' MAG as true damage at the end of the turn';
		this.qualityList = [[40, 65]];
	}

	// Override
	bind(animal, duration, tags) {
		for (let i in animal.buffs) {
			if (animal.buffs[i].id == this.id && animal.buffs[i].from.pid == this.from.pid) {
				animal.buffs[i].duration += duration;
				return;
			}
		}

		super.bind(animal, duration, tags);
	}

	postTurn(animal, ally, enemy, action) {
		if (!this.from) return;
		if (animal.stats.hp[0] <= 0) return;

		let logs = new Logs();

		// Calculate and deal damage
		let damage = WeaponInterface.getDamage(this.from.stats.mag, this.stats[0] / 100);
		damage = WeaponInterface.inflictDamage(this.from, animal, damage, WeaponInterface.TRUE, {
			me: this.from,
			allies: enemy,
			enemies: ally,
		});
		logs.push(
			`[POIS] ${this.from.nickname} damaged ${animal.nickname} for ${damage.amount} HP`,
			damage.logs
		);

		super.postTurn(animal, ally, enemy, action);

		return logs;
	}
};
