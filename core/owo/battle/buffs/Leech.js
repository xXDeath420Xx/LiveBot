/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/buffs/Leech.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import BuffInterface from '../BuffInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Logs from '../util/logUtil.js';

export default class Leech extends BuffInterface {
	init() {
		this.id = 11;
		this.name = 'Leech';
		this.debuff = true;
		this.emoji = '<:leech:1107927378816159754>';
		this.statDesc =
			'User who applied this debuff steals **?%** of incoming heals and **?%** of incoming replenishes.';
		this.qualityList = [
			[30, 60],
			[30, 60],
		];
	}

	healed(animal, healer, amount, tag) {
		if (tag.has('leech', animal)) return;
		let logs = new Logs();

		let stolen = amount[0] * (this.stats[0] / 100);
		amount[1] -= stolen;

		const tagCopy = tag.copy({
			me: this.from,
			allies: tag.allies,
			enemies: tag.enemies,
		});
		tagCopy.add('leech', animal);
		const heal = WeaponInterface.heal(this.from, stolen, this.from, tagCopy);

		logs.push(
			`[LECH] ${this.from.nickname} stole ${Math.round(stolen)} healing from ${animal.nickname}`,
			heal.logs
		);
		return logs;
	}

	replenished(animal, healer, amount, tag) {
		if (tag.has('leech', animal)) return;
		let logs = new Logs();

		let stolen = amount[0] * (this.stats[1] / 100);
		amount[1] -= stolen;

		const tagCopy = tag.copy({
			me: this.from,
			allies: tag.allies,
			enemies: tag.enemies,
		});
		tagCopy.add('leech', animal);
		const replenish = WeaponInterface.replenish(this.from, stolen, this.from, tagCopy);

		logs.push(
			`[LECH] ${this.from.nickname} stole ${Math.round(stolen)} replenishing from ${
				animal.nickname
			}`,
			replenish.logs
		);
		return logs;
	}
};
