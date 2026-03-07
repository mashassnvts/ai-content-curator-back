/**
 * Хелперы для ручной инструментации Langfuse, OpenLIT и MLflow.
 * - OBSERVABILITY_TOOL=langfuse: использует @langfuse/tracing (startActiveObservation).
 * - OBSERVABILITY_TOOL=openlit: создаёт OTel span'ы через @opentelemetry/api (их экспортирует OpenLIT в Langfuse).
 * - OBSERVABILITY_TOOL=mlflow: логирует runs в MLflow Tracking Server (REST API, без Langfuse).
 */
let startActiveObservation: typeof import('@langfuse/tracing')['startActiveObservation'] | null = null;
try {
    startActiveObservation = require('@langfuse/tracing').startActiveObservation;
} catch (e) {
    if (process.env.OBSERVABILITY_ENABLED === 'true') {
        console.warn('[Observability] @langfuse/tracing not installed. Run: npm install @langfuse/otel @langfuse/tracing @opentelemetry/sdk-node');
    }
}

let otelTrace: typeof import('@opentelemetry/api').trace | null = null;
let SpanKind: typeof import('@opentelemetry/api').SpanKind | null = null;
try {
    const api = require('@opentelemetry/api');
    otelTrace = api.trace;
    SpanKind = api.SpanKind;
} catch {
    // @opentelemetry/api is transitive from openlit / @opentelemetry/sdk-node
}

const useLangfuse = () =>
    startActiveObservation != null &&
    process.env.OBSERVABILITY_ENABLED === 'true' &&
    process.env.OBSERVABILITY_TOOL?.toLowerCase() === 'langfuse';

const useOpenlit = () =>
    otelTrace != null &&
    SpanKind != null &&
    process.env.OBSERVABILITY_ENABLED === 'true' &&
    process.env.OBSERVABILITY_TOOL?.toLowerCase() === 'openlit';

const useMlflow = () =>
    process.env.OBSERVABILITY_ENABLED === 'true' &&
    process.env.OBSERVABILITY_TOOL?.toLowerCase() === 'mlflow';

function getMlflowClientSafe(): typeof import('./mlflow-client').getMlflowClient | null {
    try {
        return require('./mlflow-client').getMlflowClient;
    } catch {
        return null;
    }
}

function extractUsageFromResult(result: unknown): { promptTokens?: number; outputTokens?: number; totalTokens?: number } {
    if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        const usage = r.usageMetadata ?? r.usage;
        if (usage && typeof usage === 'object') {
            const u = usage as Record<string, unknown>;
            return {
                promptTokens: typeof u.promptTokenCount === 'number' ? u.promptTokenCount : undefined,
                outputTokens: typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : undefined,
                totalTokens: typeof u.totalTokenCount === 'number' ? u.totalTokenCount : undefined,
            };
        }
    }
    return {};
}

const TRACER_NAME = 'ai-content-curator';
const TRACER_VERSION = '1.0';

function truncateForAttribute(value: string, max = 10000): string {
    return value.length <= max ? value : value.slice(0, max) + '…';
}

/**
 * Оборачивает LLM-вызов в generation span (Langfuse или OTel при OpenLIT).
 */
export async function traceGeneration<T>(
    name: string,
    model: string,
    input: string | object,
    fn: () => Promise<T>
): Promise<T> {
    if (useLangfuse() && startActiveObservation) {
        return startActiveObservation(
            name,
            async (gen) => {
                gen.update({
                    model,
                    input: typeof input === 'string' ? input : JSON.stringify(input),
                });
                const result = await fn();
                const output = typeof result === 'object' && result !== null
                    ? JSON.stringify(result).slice(0, 10000)
                    : String(result);
                gen.update({ output });
                return result;
            },
            { asType: 'generation' }
        );
    }

    if (useOpenlit() && otelTrace && SpanKind) {
        const tracer = otelTrace.getTracer(TRACER_NAME, TRACER_VERSION);
        const spanName = `${name} ${model}`.trim() || name;
        const isEmbedding = /embed|embedding/i.test(name);
        const span = tracer.startSpan(spanName, {
            kind: SpanKind.CLIENT,
            attributes: {
                'gen_ai.operation.name': isEmbedding ? 'embeddings' : 'generate_content',
                'gen_ai.provider.name': 'gcp.gen_ai',
                'gen_ai.request.model': model,
                'gen_ai.output.type': 'text',
                'gen_ai.input.messages': typeof input === 'string'
                    ? truncateForAttribute(input)
                    : truncateForAttribute(JSON.stringify(input)),
            },
        });
        try {
            const result = await fn();
            const output =
                typeof result === 'object' && result !== null
                    ? JSON.stringify(result)
                    : String(result);
            span.setAttribute('gen_ai.output.messages', truncateForAttribute(output));
            span.setStatus({ code: 1 }); // OK
            return result;
        } catch (err) {
            span.setStatus({
                code: 2, // ERROR
                message: err instanceof Error ? err.message : String(err),
            });
            span.setAttribute('error.type', err instanceof Error ? err.name : '_OTHER');
            throw err;
        } finally {
            span.end();
        }
    }

    if (useMlflow()) {
        const getClient = getMlflowClientSafe();
        if (getClient) {
            const runName = `${name} ${model}`.trim() || name;
            const startTime = Date.now();
            let runId: string | null = null;
            try {
                const client = getClient();
                const run = await client.createRun(runName, {
                    'mlflow.source.name': 'ai-content-curator',
                    'gen_ai.operation': /embed|embedding/i.test(name) ? 'embeddings' : 'generate_content',
                    'gen_ai.provider': 'gcp.gen_ai',
                });
                runId = run.run_id;
                const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
                await client.logBatch(runId, [
                    { key: 'model', value: model },
                    { key: 'input', value: inputStr },
                ]);
                const result = await fn();
                const outputStr =
                    typeof result === 'object' && result !== null ? JSON.stringify(result) : String(result);
                const usage = extractUsageFromResult(result);
                const params: Array<{ key: string; value: string }> = [{ key: 'output', value: outputStr }];
                const metrics: Array<{ key: string; value: number }> = [
                    { key: 'latency_ms', value: Date.now() - startTime },
                ];
                if (usage.promptTokens != null) metrics.push({ key: 'prompt_tokens', value: usage.promptTokens });
                if (usage.outputTokens != null) metrics.push({ key: 'output_tokens', value: usage.outputTokens });
                if (usage.totalTokens != null) metrics.push({ key: 'total_tokens', value: usage.totalTokens });
                await client.logBatch(runId, params, metrics);
                await client.updateRun(runId, 'FINISHED');
                return result;
            } catch (err) {
                if (runId) {
                    try {
                        const client = getClient();
                        await client.logParameter(runId, 'error', err instanceof Error ? err.message : String(err));
                        await client.updateRun(runId, 'FAILED');
                    } catch (_) {
                        /* ignore */
                    }
                    throw err;
                } else {
                    console.warn('[Observability] MLflow logging failed (running without trace):', err instanceof Error ? err.message : String(err));
                    return fn();
                }
            }
        }
    }

    return fn();
}

/**
 * Оборачивает произвольный span.
 */
export async function traceSpan<T>(
    name: string,
    fn: () => Promise<T>,
    meta?: Record<string, unknown>
): Promise<T> {
    if (useLangfuse() && startActiveObservation) {
        return startActiveObservation(name, async (span) => {
            if (meta) span.update(meta);
            return fn();
        });
    }

    if (useOpenlit() && otelTrace && SpanKind) {
        const tracer = otelTrace.getTracer(TRACER_NAME, TRACER_VERSION);
        const span = tracer.startSpan(name, {
            kind: SpanKind.INTERNAL,
            attributes: meta
                ? Object.fromEntries(
                    Object.entries(meta).map(([k, v]) => [
                        k,
                        typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
                    ])
                )
                : undefined,
        });
        try {
            const result = await fn();
            span.setStatus({ code: 1 });
            return result;
        } catch (err) {
            span.setStatus({
                code: 2,
                message: err instanceof Error ? err.message : String(err),
            });
            span.setAttribute('error.type', err instanceof Error ? err.name : '_OTHER');
            throw err;
        } finally {
            span.end();
        }
    }

    if (useMlflow()) {
        const getClient = getMlflowClientSafe();
        if (getClient) {
            const startTime = Date.now();
            let runId: string | null = null;
            try {
                const client = getClient();
                const run = await client.createRun(name, { 'mlflow.source.name': 'ai-content-curator' });
                runId = run.run_id;
                if (meta && Object.keys(meta).length > 0) {
                    const params = Object.entries(meta).map(([k, v]) => ({
                        key: k,
                        value: typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
                    }));
                    await client.logBatch(runId, params);
                }
                const result = await fn();
                await client.logMetric(runId, 'latency_ms', Date.now() - startTime);
                await client.updateRun(runId, 'FINISHED');
                return result;
            } catch (err) {
                if (runId) {
                    try {
                        const client = getClient();
                        await client.logParameter(runId, 'error', err instanceof Error ? err.message : String(err));
                        await client.updateRun(runId, 'FAILED');
                    } catch (_) {
                        /* ignore */
                    }
                    throw err;
                } else {
                    console.warn('[Observability] MLflow logging failed (running without trace):', err instanceof Error ? err.message : String(err));
                    return fn();
                }
            }
        }
    }

    return fn();
}
