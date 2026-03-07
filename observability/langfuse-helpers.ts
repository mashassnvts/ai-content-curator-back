/**
 * Хелперы для ручной инструментации Langfuse.
 * Используются только когда OBSERVABILITY_TOOL=langfuse.
 * Если пакеты не установлены — работают как no-op (просто вызывают fn).
 */
let startActiveObservation: typeof import('@langfuse/tracing')['startActiveObservation'] | null = null;
try {
    startActiveObservation = require('@langfuse/tracing').startActiveObservation;
} catch (e) {
    // Пакеты не установлены — observability отключена
    if (process.env.OBSERVABILITY_ENABLED === 'true') {
        console.warn('[Observability] @langfuse/tracing not installed. Run: npm install @langfuse/otel @langfuse/tracing @opentelemetry/sdk-node');
    }
}

const useLangfuse = () =>
    startActiveObservation != null &&
    process.env.OBSERVABILITY_ENABLED === 'true' &&
    process.env.OBSERVABILITY_TOOL?.toLowerCase() === 'langfuse';

/**
 * Оборачивает LLM-вызов в generation span Langfuse.
 */
export async function traceGeneration<T>(
    name: string,
    model: string,
    input: string | object,
    fn: () => Promise<T>
): Promise<T> {
    if (!useLangfuse() || !startActiveObservation) return fn();

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

/**
 * Оборачивает произвольный span.
 */
export async function traceSpan<T>(
    name: string,
    fn: () => Promise<T>,
    meta?: Record<string, unknown>
): Promise<T> {
    if (!useLangfuse() || !startActiveObservation) return fn();

    return startActiveObservation(name, async (span) => {
        if (meta) span.update(meta);
        const result = await fn();
        return result;
    });
}
