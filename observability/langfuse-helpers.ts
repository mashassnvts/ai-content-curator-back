/**
 * Хелперы для ручной инструментации Langfuse и OpenLIT.
 * - OBSERVABILITY_TOOL=langfuse: использует @langfuse/tracing (startActiveObservation).
 * - OBSERVABILITY_TOOL=openlit: создаёт OTel span'ы через @opentelemetry/api (их экспортирует OpenLIT в Langfuse).
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

    return fn();
}
