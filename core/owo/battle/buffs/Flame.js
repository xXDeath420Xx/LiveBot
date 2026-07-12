/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/buffs/Flame.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import BuffInterface from '../BuffInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Logs from '../util/logUtil.js';
import Tags from '../util/tags.js';

export default class Flame extends BuffInterface {
	init() {
		this.id = 3;
		this.name = 'Flame';
		this.debuff = true;
		this.emoji = '<:flame:572915106854469633>';
		this.statDesc =
			'Deals **?%** of your ' +
			WeaponInterface.magEmoji +
			' MAG at the end of the turn. Applying flame on a target that already has flame will explode and deal **?%** damage to the target.';
		this.qualityList = [
			[20, 40],
			[60, 80],
		];
	}

	// Override
	bind(animal, duration, tags) {
		if (!(tags instanceof Tags)) {
			tags = new Tags({
				me: tags.me,
				allies: tags.allies,
				enemies: tags.enemies,
			});
		}
		if (tags.has('flame', animal)) return;
		let logs = new Logs();
		for (let i in animal.buffs) {
			if (animal.buffs[i].id == this.id && !animal.buffs[i].markedForDeath) {
				animal.buffs[i].markedForDeath = true;
				let damage = WeaponInterface.getDamage(this.from.stats.mag, this.stats[1] / 100);
				const tagsCopy = tags.copyAdd('flame', animal);
				damage = WeaponInterface.inflictDamage(
					this.from,
					animal,
					damage,
					WeaponInterface.MAGICAL,
					tagsCopy
				);
				logs.push(
					`[FLAME] Exploded and damaged ${animal.nickname} for ${damage.amount} HP`,
					damage.logs
				);
			}
		}

		super.bind(animal, duration, tags);
		return logs;
	}

	postTurn(animal, ally, enemy, action) {
		if (!this.from) return;
		if (animal.stats.hp[0] <= 0) return;
		if (this.markedForDeath) return;

		let logs = new Logs();

		// Calculate and deal damage
		let damage = WeaponInterface.getDamage(this.from.stats.mag, this.stats[0] / 100);
		damage = WeaponInterface.inflictDamage(this.from, animal, damage, WeaponInterface.MAGICAL, {
			me: this.from,
			allies: enemy,
			enemies: ally,
		});
		logs.push(
			`[FLAME] ${this.from.nickname} damaged ${animal.nickname} for ${damage.amount} HP`,
			damage.logs
		);

		super.postTurn(animal, ally, enemy, action);

		return logs;
	}
};
