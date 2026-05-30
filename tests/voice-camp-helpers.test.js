import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReturnToCamp, isVoiceChannelType } from '../core/voice-camp-helpers.js';
import { ChannelType } from 'discord.js';

test('shouldReturnToCamp: no camp configured -> false', () => {
    assert.equal(shouldReturnToCamp('A', null), false);
    assert.equal(shouldReturnToCamp(null, null), false);
});

test('shouldReturnToCamp: connected elsewhere -> true', () => {
    assert.equal(shouldReturnToCamp('A', 'CAMP'), true);
});

test('shouldReturnToCamp: already in camp -> false', () => {
    assert.equal(shouldReturnToCamp('CAMP', 'CAMP'), false);
});

test('shouldReturnToCamp: not connected but camp set -> true', () => {
    assert.equal(shouldReturnToCamp(null, 'CAMP'), true);
});

test('isVoiceChannelType: accepts voice and stage', () => {
    assert.equal(isVoiceChannelType(ChannelType.GuildVoice), true);
    assert.equal(isVoiceChannelType(ChannelType.GuildStageVoice), true);
});

test('isVoiceChannelType: rejects text', () => {
    assert.equal(isVoiceChannelType(ChannelType.GuildText), false);
});
