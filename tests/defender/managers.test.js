import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../utils/db.js';
import { addManager, removeManager, isManager, managerCount } from '../../services/certifried-bot/defender/managers.js';

const TEST_USER = 990001;

after(async () => {
    await pool.execute('DELETE FROM kbd_managers WHERE tokes_user_id = ?', [TEST_USER]);
    await pool.end();
});

test('addManager then isManager true', async () => {
    await addManager(TEST_USER, null);
    assert.equal(await isManager(TEST_USER), true);
});

test('isManager(null) is false', async () => {
    assert.equal(await isManager(null), false);
});

test('managerCount is a number', async () => {
    assert.equal(typeof (await managerCount()), 'number');
});

test('removeManager then isManager false', async () => {
    await removeManager(TEST_USER);
    assert.equal(await isManager(TEST_USER), false);
});
