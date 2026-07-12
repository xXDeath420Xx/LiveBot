/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/buffs/Stinky.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import BuffInterface from '../BuffInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Logs from '../util/logUtil.js';

export default class Stinky extends BuffInterface {
	init() {
		this.id = 12;
		this.name = 'Stinky';
		this.debuff = true;
		this.emoji = '<:stinky:1154636430937698364>';
		this.statDesc = `Prevents any future buffs *AND* debuffs to be applied to this animal. On success, deal **?%** ${WeaponInterface.magEmoji}MAG to the animal.`;
		this.qualityList = [[20, 50]];
	}

	// Override
	preBind(animal, duration, tags, buffToAdd) {
		if (tags.has('stinky', this.from)) return;

		let logs = new Logs();

		let damage = WeaponInterface.getDamage(this.from.stats.mag, this.stats[0] / 100);
		const tagsCopy = tags.copyAdd('stinky', this.from);
		damage = WeaponInterface.inflictDamage(
			this.from,
			animal,
			damage,
			WeaponInterface.MAGICAL,
			tagsCopy
		);
		logs.push(
			`[STINK] Prevented ${buffToAdd.name} ${buffToAdd.debuff ? 'de' : ''}buff and damaged ${
				animal.nickname
			} for ${damage.amount} HP`,
			damage.logs
		);

		return {
			logs: logs,
			dontBind: true,
		};
	}
};
