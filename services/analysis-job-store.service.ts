/**
 * Хранилище состояния задач анализа.
 * При наличии Redis — синхронизирует состояние между инстансами (важно для Railway и др.).
 * Без Redis — использует in-memory Map (локальная разработка).
 */

import Redis from 'ioredis';

const JOB_PREFIX = 'analysis:job:';
const JOB_TTL_SEC = 3600; // 1 час

let redis: Redis | null = null;

function getRedis(): Redis | null {
    if (redis) return redis;
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
        redis = new Redis(url, { maxRetriesPerRequest: 2 });
        redis.on('error', () => {});
        return redis;
    } catch {
        return null;
    }
}

export interface AnalysisJobState {
    status: 'pending' | 'in_progress' | 'completed' | 'error';
    results?: any[];
    error?: string;
    totalExpected?: number;
    itemType?: string;
    currentItemIndex?: number;
    currentStage?: number;
    useMetadata?: boolean;
    channelProgress?: number;
    [key: string]: any;
}

const memoryStore = new Map<string, AnalysisJobState>();

export function setAnalysisJob(jobId: string, state: AnalysisJobState): void {
    memoryStore.set(jobId, state);
    const r = getRedis();
    if (r) {
        const key = JOB_PREFIX + jobId;
        r.setex(key, JOB_TTL_SEC, JSON.stringify(state)).catch(() => {});
    }
}

/** Синхронное чтение из памяти (для обратной совместимости в runAnalysisInBackground) */
export function getAnalysisJobSync(jobId: string): AnalysisJobState | undefined {
    return memoryStore.get(jobId);
}

export async function getAnalysisJob(jobId: string): Promise<AnalysisJobState | undefined> {
    const r = getRedis();
    if (r) {
        try {
            const key = JOB_PREFIX + jobId;
            const raw = await r.get(key);
            if (raw) {
                const parsed = JSON.parse(raw) as AnalysisJobState;
                if (parsed) return parsed;
            }
        } catch {
            // fallback to memory
        }
    }
    return memoryStore.get(jobId);
}

export function deleteAnalysisJob(jobId: string): void {
    memoryStore.delete(jobId);
    const r = getRedis();
    if (r) {
        r.del(JOB_PREFIX + jobId).catch(() => {});
    }
}

export function isRedisAvailable(): boolean {
    return !!getRedis();
}
