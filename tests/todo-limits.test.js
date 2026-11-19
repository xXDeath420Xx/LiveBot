import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TODO_LIMITS } from '../core/todo-limits.js';

/*
 * /todo and the Task lists page share one set of limits (core/todo-limits.js): a title of 256
 * characters, a task of 200 and 50 tasks a list. /todo used to accept any length and any number.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('the limits the page shows', () => {
    assert.deepEqual({ ...TODO_LIMITS }, { title: 256, task: 200, items: 50 });
    const page = read('dashboard/views/partials/manage/todo.ejs');
    assert.match(page, /id="todoTitle"[^>]*maxlength="256"/);
    assert.match(page, /addInput\.maxLength = 200;/);
});

test('/todo create and add cap their options, and add refuses a full list', async () => {
    const { default: cmd } = await import('../commands/admin/todo.js');
    const json = cmd.data.toJSON();
    const opt = (sub, name) => json.options.find((o) => o.name === sub).options.find((o) => o.name === name);
    assert.equal(opt('create', 'title').max_length, TODO_LIMITS.title);
    assert.equal(opt('add', 'task').max_length, TODO_LIMITS.task);
    assert.match(read('commands/admin/todo.js'), /Number\(n\) >= TODO_LIMITS\.items/);
});

test('the page API uses the same limits', () => {
    assert.match(read('dashboard/routes/api/features/todo.js'), /from '..\/..\/..\/..\/core\/todo-limits\.js'/);
});
