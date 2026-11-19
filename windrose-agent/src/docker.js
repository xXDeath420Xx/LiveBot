// Container lifecycle — the only code in this project that touches Docker.
//
// SECURITY BOUNDARY. Holding the Docker socket is root-equivalent on this host,
// which is precisely why it lives here in a ~200-line service with an
// enumerated API and not in dashboard/server.js (10k lines, public-facing,
// three auth systems). Two rules keep that boundary meaningful:
//
//   1. The container is addressed by the pinned CONTAINER_NAME constant from
//      config.js. No function here takes a container name as an argument, so
//      no request can ever redirect these operations at another container.
//   2. There is no generic exec/run primitive. Adding one would hand anything
//      that reaches :4091 a root shell, which would undo the entire split.
//
// If you find yourself wanting "just run this one docker command", add a named
// operation with a fixed shape instead.

import Docker from 'dockerode';
import { config } from './config.js';

export function createDocker({ docker = new Docker(), containerName = config.containerName } = {}) {
    const container = () => docker.getContainer(containerName);

    async function inspect() {
        try {
            return await container().inspect();
        } catch (err) {
            if (err.statusCode === 404) return null;
            throw err;
        }
    }

    async function state() {
        const info = await inspect();
        if (!info) return { exists: false, running: false, status: 'absent' };
        return {
            exists: true,
            running: info.State.Running === true,
            status: info.State.Status,
            startedAt: info.State.StartedAt,
            restartCount: info.RestartCount ?? 0,
            // Surfaced so the panel can distinguish "we stopped it" from "the
            // memory cap killed it", which look identical in a status badge.
            oomKilled: info.State.OOMKilled === true,
            exitCode: info.State.ExitCode,
            image: info.Config?.Image ?? null,
            memLimitBytes: info.HostConfig?.Memory ?? 0,
        };
    }

    return {
        state,
        inspect,

        async start() {
            const s = await state();
            if (!s.exists) throw new Error(`docker: container ${containerName} does not exist`);
            if (s.running) return { changed: false, ...s };
            await container().start();
            return { changed: true, ...(await state()) };
        },

        /**
         * Stop with the compose stop_grace_period. The game needs that window
         * to flush the world; cutting it short is how saves get corrupted.
         */
        async stop({ timeoutSec = 30 } = {}) {
            const s = await state();
            if (!s.exists) throw new Error(`docker: container ${containerName} does not exist`);
            if (!s.running) return { changed: false, ...s };
            await container().stop({ t: timeoutSec });
            return { changed: true, ...(await state()) };
        },

        async restart({ timeoutSec = 30 } = {}) {
            const s = await state();
            if (!s.exists) throw new Error(`docker: container ${containerName} does not exist`);
            await container().restart({ t: timeoutSec });
            return { changed: true, ...(await state()) };
        },

        /**
         * One-shot resource sample. `stream: false` matters — a streaming stats
         * call leaves a socket open per request and will leak under polling.
         */
        async stats() {
            const s = await state();
            if (!s.running) return { running: false };

            const raw = await container().stats({ stream: false });
            const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
            const sysDelta = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
            const cores = raw.cpu_stats.online_cpus || 1;

            // Docker reports cache as part of usage; subtracting it gives the
            // number that actually matters against mem_limit.
            const cache = raw.memory_stats.stats?.inactive_file ?? 0;
            const memUsed = (raw.memory_stats.usage ?? 0) - cache;
            const memLimit = raw.memory_stats.limit ?? 0;

            return {
                running: true,
                cpuPercent: sysDelta > 0 ? +((cpuDelta / sysDelta) * cores * 100).toFixed(2) : 0,
                memUsedBytes: memUsed,
                memLimitBytes: memLimit,
                memPercent: memLimit > 0 ? +((memUsed / memLimit) * 100).toFixed(2) : 0,
            };
        },

        /** Tail recent logs. Bounded — never stream unbounded output to a web client. */
        async logs({ tail = 200 } = {}) {
            const s = await state();
            if (!s.exists) return '';
            const buf = await container().logs({ stdout: true, stderr: true, tail, follow: false, timestamps: false });
            return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
        },
    };
}
