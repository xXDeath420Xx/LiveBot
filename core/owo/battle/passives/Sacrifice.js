/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Sacrifice.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Log from '../util/logUtil.js';

export default class Sacrifice extends PassiveInterface {
	init() {
		this.id = 19;
		this.name = 'Sacrifice';
		this.basicDesc = '';
		this.emojis = [
			'<:csac:1107928491527249980>',
			'<:usac:1107928527300460545>',
			'<:rsac:1107928523110367253>',
			'<:esac:1107928494329040968>',
			'<:msac:1107928502893826098>',
			'<:lsac:1107928500230426654>',
			'<:fsac:1107928498103930901>',
		];
		this.statDesc = `When this animal dies, heal your teammates for **?%** of its Max ${WeaponInterface.hpEmoji}HP and replenish for **?%** of its Max ${WeaponInterface.wpEmoji}WP`;

		this.qualityList = [
			[50, 75],
			[50, 75],
		];
	}

	postAttacked(animal, attacker, totalDamage, type, tags) {
		if (tags.has('sacrifice', animal)) return;
		// Only active when dead
		if (animal.stats.hp[0] > 0) return;

		let logs = new Log();

		let alive = WeaponInterface.getAlive(tags.getAnimalAllies(animal));

		let healAmount = WeaponInterface.getDamageFromHpWp(animal.stats.hp, this.stats[0] / 100);
		let wpAmount = WeaponInterface.getDamageFromHpWp(animal.stats.wp, this.stats[1] / 100);
		const tagsCopy1 = tags.copyAdd('sacrifice', animal, {
			me: animal,
			allies: tags.allies,
			enemies: tags.enemies,
		});
		const tagsCopy2 = tags.copyAdd('sacrifice', animal, {
			me: animal,
			allies: tags.allies,
			enemies: tags.enemies,
		});

		let healLogText = `[SAC] ${animal.nickname} healed `;
		let healSubLogs = new Log();
		let repLogText = `[SAC] ${animal.nickname} replenished `;
		let repSubLogs = new Log();
		for (let i in alive) {
			let team = alive[i];
			if (team.pid !== animal.pid) {
				let heal = WeaponInterface.heal(team, healAmount, animal, tagsCopy1);
				healLogText += `${team.nickname} ${heal.amount} | `;
				healSubLogs.push(heal.logs);

				let wp = WeaponInterface.replenish(team, wpAmount, animal, tagsCopy2);
				repLogText += `${team.nickname} ${wp.amount} | `;
				repSubLogs.push(wp.logs);
			}
		}

		healLogText = healLogText.slice(0, -2) + 'HP';
		logs.push(healLogText, healSubLogs);

		repLogText = repLogText.slice(0, -2) + 'WP';
		logs.push(repLogText, repSubLogs);

		return logs;
	}
};
