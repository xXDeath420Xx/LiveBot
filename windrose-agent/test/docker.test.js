import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocker } from '../src/docker.js';

// Docker double. Records which container name was requested so we can assert
// the pinned-name guarantee.
function fakeDocker({ running = true, exists = true, statsRaw = null } = {}) {
    const requested = [];
    const calls = [];
    const inspectResult = {
        State: { Running: running, Status: running ? 'running' : 'exited', StartedAt: '2026-08-08T23:15:00Z', OOMKilled: false, ExitCode: 0 },
        RestartCount: 0,
        Config: { Image: 'indifferentbroccoli/windrose-server-docker' },
        HostConfig: { Memory: 17179869184 },
    };
    return {
        requested,
        calls,
        getContainer(name) {
            requested.push(name);
            return {
                inspect: async () => {
                    if (!exists) { const e = new Error('no such container'); e.statusCode = 404; throw e; }
                    return inspectResult;
                },
                start: async () => { calls.push('start'); inspectResult.State.Running = true; inspectResult.State.Status = 'running'; },
                stop: async (o) => { calls.push(`stop:${o.t}`); inspectResult.State.Running = false; inspectResult.State.Status = 'exited'; },
                restart: async (o) => { calls.push(`restart:${o.t}`); },
                stats: async (o) => { calls.push(`stats:stream=${o.stream}`); return statsRaw; },
                logs: async () => Buffer.from('line1\nline2\n'),
            };
        },
    };
}

test('always addresses the pinned container name', async () => {
    // The security property that makes the agent/dashboard split meaningful:
    // no operation may be redirected at another container.
    const docker = fakeDocker();
    const d = createDocker({ docker });

    await d.state();
    await d.start();
    await d.stop();
    await d.logs();

    assert.ok(docker.requested.length > 0);
    assert.deepEqual([...new Set(docker.requested)], ['windrose']);
});

test('exposes no generic exec primitive', () => {
    // Adding one would hand anything reaching :4091 a root shell.
    const d = createDocker({ docker: fakeDocker() });
    for (const forbidden of ['exec', 'run', 'command', 'shell']) {
        assert.equal(typeof d[forbidden], 'undefined', `${forbidden}() must not exist`);
    }
});

test('reports absent containers instead of throwing', async () => {
    const d = createDocker({ docker: fakeDocker({ exists: false }) });
    assert.deepEqual(await d.state(), { exists: false, running: false, status: 'absent' });
});

test('start is a no-op when already running', async () => {
    const docker = fakeDocker({ running: true });
    const d = createDocker({ docker });
    const out = await d.start();
    assert.equal(out.changed, false);
    assert.equal(docker.calls.includes('start'), false);
});

test('stop passes the grace period the game needs to flush the world', async () => {
    const docker = fakeDocker({ running: true });
    const d = createDocker({ docker });
    await d.stop({ timeoutSec: 30 });
    assert.ok(docker.calls.includes('stop:30'), 'cutting the grace period short risks save corruption');
});

test('surfaces OOMKilled so the panel can explain an unexpected exit', async () => {
    const docker = fakeDocker({ running: false });
    const d = createDocker({ docker });
    const s = await d.state();
    assert.equal('oomKilled' in s, true);
    assert.equal(s.memLimitBytes, 17179869184);
});

test('stats are a one-shot sample, never a stream', async () => {
    const statsRaw = {
        cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        memory_stats: { usage: 2_000_000_000, limit: 17_179_869_184, stats: { inactive_file: 500_000_000 } },
    };
    const docker = fakeDocker({ running: true, statsRaw });
    const d = createDocker({ docker });

    const s = await d.stats();
    // A streaming call leaks a socket per request under polling.
    assert.ok(docker.calls.includes('stats:stream=false'));
    // Cache must be excluded — it is what makes usage look alarming otherwise.
    assert.equal(s.memUsedBytes, 1_500_000_000);
    assert.equal(s.cpuPercent, 40);
});
