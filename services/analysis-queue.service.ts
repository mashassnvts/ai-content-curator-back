/**
 * Очередь анализа контента (Bull + Redis).
 * Позволяет обрабатывать несколько запросов параллельно (2+ воркера),
 * чтобы два и более пользователей не блокировали друг друга.
 */

import Queue from 'bull';

export interface AnalysisJobData {
    jobId: string;
    urlInput: string | string[];
    interests: string;
    analysisMode: 'read' | 'unread';
    userId?: number;
}

export type AnalysisJobHandler = (data: AnalysisJobData) => Promise<void>;

let analysisQueue: Queue.Queue<AnalysisJobData> | null = null;
let handler: AnalysisJobHandler | null = null;
let useQueue = false;

const QUEUE_NAME = 'content-analysis';
const CONCURRENCY = parseInt(process.env.ANALYSIS_QUEUE_CONCURRENCY || '2', 10);

/**
 * Инициализирует очередь и воркеры. Вызывается при старте сервера.
 * @param runAnalysis - функция выполнения анализа (runAnalysisInBackground)
 */
export function initAnalysisQueue(runAnalysis: AnalysisJobHandler): boolean {
    handler = runAnalysis;
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    try {
        analysisQueue = new Queue<AnalysisJobData>(QUEUE_NAME, redisUrl, {
            defaultJobOptions: {
                removeOnComplete: 100,
                removeOnFail: 50,
                attempts: 2,
                backoff: { type: 'exponential', delay: 5000 },
            },
        });

        analysisQueue.process(CONCURRENCY, async (job) => {
            const fn = handler;
            if (!fn) {
                throw new Error('Analysis handler not registered');
            }
            await fn(job.data);
        });

        analysisQueue.on('error', (err) => {
            console.error('❌ [Analysis Queue] Redis error:', err.message);
        });

        analysisQueue.on('failed', (job, err) => {
            console.error(`❌ [Analysis Queue] Job ${job?.id} failed:`, err?.message);
        });

        useQueue = true;
        console.log(`✅ [Analysis Queue] Started with concurrency=${CONCURRENCY} (Redis: ${redisUrl})`);
        return true;
    } catch (err: any) {
        console.warn('⚠️ [Analysis Queue] Redis unavailable, using fallback (setImmediate):', err?.message);
        useQueue = false;
        return false;
    }
}

/**
 * Добавляет задачу в очередь или выполняет сразу (fallback без Redis).
 */
export async function addAnalysisJob(data: AnalysisJobData): Promise<boolean> {
    if (useQueue && analysisQueue) {
        try {
            await analysisQueue.add(data, { jobId: data.jobId });
            return true;
        } catch (err: any) {
            console.warn('⚠️ [Analysis Queue] Redis add failed, using fallback:', err?.message);
            useQueue = false;
            return false;
        }
    }
    return false;
}

/**
 * Используется ли очередь (Redis доступен).
 */
export function isQueueEnabled(): boolean {
    return useQueue;
}

/**
 * Закрывает очередь при остановке сервера.
 */
export async function closeAnalysisQueue(): Promise<void> {
    if (analysisQueue) {
        await analysisQueue.close();
        analysisQueue = null;
        useQueue = false;
        console.log('🛑 [Analysis Queue] Closed');
    }
}
