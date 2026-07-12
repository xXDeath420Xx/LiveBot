/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/pet.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import CommandInterface from '../../CommandInterface.js';

import user_emote from '../emotes/user_emote.js';
import petUtil from './util/petUtil.js';

export default new CommandInterface({
	alias: ['pets', 'pet'],

	args: '',

	desc: 'Displays your current pets! Add them by using them in battles!',

	example: [],

	related: ['owo battle', 'owo zoo'],

	permissions: ['sendMessages', 'embedLinks', 'addReactions'],

	group: ['animals'],

	cooldown: 5000,
	half: 200,
	six: 600,

	execute: async function (p) {
		/* Is this a pat action? */
		if (p.global.isUser(p.args[0])) {
			p.command = 'pat';
			user_emote.execute(p);
			return;
		}

		if (p.args.length != 0) {
			p.errorMsg(', Incorrect arguments');
			return;
		}

		let animals = await petUtil.getAnimals(p);

		let embed = petUtil.getDisplay(p, animals);

		await p.send(embed);
	},
});
