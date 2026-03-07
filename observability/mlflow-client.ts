/**
 * MLflow REST API client для логирования runs (params, metrics, tags).
 * Работает напрямую с MLflow Tracking Server, без Langfuse.
 *
 * Переменные окружения:
 *   MLFLOW_TRACKING_URI - http://localhost:5000 (по умолчанию)
 *   MLFLOW_EXPERIMENT_NAME - ai-content-curator (по умолчанию)
 */

import axios, { AxiosInstance } from 'axios';

const TRACKING_URI = (process.env.MLFLOW_TRACKING_URI || 'http://localhost:5000').replace(/\/$/, '');
const EXPERIMENT_NAME = process.env.MLFLOW_EXPERIMENT_NAME || 'ai-content-curator';

const MAX_PARAM_VALUE = 6000; // MLflow limit for param value in bytes (UTF-8)

function truncate(str: string, maxBytes = MAX_PARAM_VALUE): string {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    if (bytes.length <= maxBytes) return str;
    const truncated = new TextDecoder().decode(bytes.slice(0, maxBytes - 3));
    return truncated + '…';
}

export interface MlflowRunInfo {
    run_id: string;
    experiment_id: string;
    run_uuid: string;
}

export class MlflowClient {
    private client: AxiosInstance;
    private experimentId: string | null = null;

    constructor(trackingUri = TRACKING_URI) {
        this.client = axios.create({
            baseURL: `${trackingUri}/api/2.0/mlflow`,
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
        });
    }

    async getOrCreateExperiment(): Promise<string> {
        if (this.experimentId) return this.experimentId;

        try {
            const { data } = await this.client.get('/experiments/get-by-name', {
                params: { experiment_name: EXPERIMENT_NAME },
            });
            this.experimentId = data.experiment?.experiment_id ?? null;
        } catch (e: unknown) {
            const err = e as { response?: { status?: number; data?: { error_code?: string } } };
            const notFound =
                err.response?.status === 404 ||
                err.response?.data?.error_code === 'RESOURCE_DOES_NOT_EXIST';
            if (notFound || err.response?.status === 500) {
                try {
                    const { data } = await this.client.post('/experiments/create', {
                        name: EXPERIMENT_NAME,
                    });
                    this.experimentId = data.experiment_id;
                } catch (createErr: unknown) {
                    const ce = createErr as { response?: { data?: { error_code?: string } } };
                    if (ce.response?.data?.error_code === 'RESOURCE_ALREADY_EXISTS') {
                        const { data } = await this.client.get('/experiments/get-by-name', {
                            params: { experiment_name: EXPERIMENT_NAME },
                        });
                        this.experimentId = data.experiment?.experiment_id ?? null;
                    } else {
                        throw createErr;
                    }
                }
            } else {
                throw e;
            }
        }

        if (!this.experimentId) {
            throw new Error(`Failed to get or create MLflow experiment: ${EXPERIMENT_NAME}`);
        }
        return this.experimentId;
    }

    async createRun(runName: string, tags?: Record<string, string>): Promise<MlflowRunInfo> {
        const experimentId = await this.getOrCreateExperiment();
        const tagsArray = tags
            ? Object.entries(tags).map(([key, value]) => ({ key, value }))
            : [];

        const { data } = await this.client.post('/runs/create', {
            experiment_id: experimentId,
            run_name: runName,
            start_time: Date.now(),
            tags: tagsArray,
        });

        return {
            run_id: data.run?.info?.run_id ?? data.run_id,
            experiment_id: experimentId,
            run_uuid: data.run?.info?.run_uuid ?? data.run_id,
        };
    }

    async logParameter(runId: string, key: string, value: string): Promise<void> {
        await this.client.post('/runs/log-parameter', {
            run_id: runId,
            key,
            value: truncate(value),
        });
    }

    async logMetric(runId: string, key: string, value: number, timestamp?: number): Promise<void> {
        await this.client.post('/runs/log-metric', {
            run_id: runId,
            key,
            value: Number(value),
            timestamp: timestamp ?? Date.now(),
        });
    }

    async setTag(runId: string, key: string, value: string): Promise<void> {
        await this.client.post('/runs/set-tag', {
            run_id: runId,
            key,
            value: truncate(value, 5000),
        });
    }

    async logBatch(
        runId: string,
        params?: Array<{ key: string; value: string }>,
        metrics?: Array<{ key: string; value: number; timestamp?: number }>,
        tags?: Array<{ key: string; value: string }>
    ): Promise<void> {
        const body: Record<string, unknown> = { run_id: runId };
        if (params?.length) {
            body.params = params.map((p) => ({ key: p.key, value: truncate(p.value) }));
        }
        if (metrics?.length) {
            const ts = Date.now();
            body.metrics = metrics.map((m) => ({
                key: m.key,
                value: Number(m.value),
                timestamp: m.timestamp ?? ts,
            }));
        }
        if (tags?.length) {
            body.tags = tags.map((t) => ({ key: t.key, value: truncate(t.value, 5000) }));
        }
        if (Object.keys(body).length > 1) {
            await this.client.post('/runs/log-batch', body);
        }
    }

    async updateRun(runId: string, status: 'RUNNING' | 'FINISHED' | 'FAILED'): Promise<void> {
        await this.client.post('/runs/update', {
            run_id: runId,
            status,
            end_time: Date.now(),
        });
    }
}

let clientInstance: MlflowClient | null = null;

export function getMlflowClient(): MlflowClient {
    if (!clientInstance) {
        clientInstance = new MlflowClient(TRACKING_URI);
    }
    return clientInstance;
}
