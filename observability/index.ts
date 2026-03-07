/**
 * Observability module: Langfuse, OpenLIT, MLflow.
 * Переключение через OBSERVABILITY_TOOL=langfuse|openlit|mlflow
 * Все три отправляют трейсы в Langfuse (mlflow — через OTel, без MLflow Tracking Server).
 */

const tool = process.env.OBSERVABILITY_TOOL?.toLowerCase().trim();
const enabled = process.env.OBSERVABILITY_ENABLED === 'true' || process.env.OBSERVABILITY_ENABLED === '1';

console.log('[Observability] OBSERVABILITY_ENABLED=', process.env.OBSERVABILITY_ENABLED, 'OBSERVABILITY_TOOL=', process.env.OBSERVABILITY_TOOL ?? '(not set)');

if (!enabled || !tool) {
    console.log('[Observability] Disabled or missing tool. Set OBSERVABILITY_ENABLED=true and OBSERVABILITY_TOOL=langfuse, openlit or mlflow');
} else if (tool === 'langfuse') {
    try {
        require('./langfuse');
        console.log('[Observability] Langfuse enabled. Traces will be sent to', process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[Observability] Langfuse init failed:', msg, '— Run: npm install @langfuse/otel @langfuse/tracing @opentelemetry/sdk-node');
    }
} else if (tool === 'openlit') {
    try {
        require('./openlit');
        console.log('[Observability] OpenLIT initialized. Traces will be sent to Langfuse.');
    } catch (e) {
        console.warn('[Observability] OpenLIT init failed. Run: npm install openlit');
    }
} else if (tool === 'mlflow') {
    const hasLangfuseKeys = !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
    if (hasLangfuseKeys) {
        try {
            require('./langfuse');
            console.log('[Observability] MLflow (via Langfuse): traces will be sent to', process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com');
        } catch (e) {
            console.warn('[Observability] Langfuse init for mlflow failed:', (e as Error)?.message ?? e);
        }
    } else {
        console.warn('[Observability] OBSERVABILITY_TOOL=mlflow requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY. Set them or use langfuse/openlit.');
    }
} else {
    console.warn(`[Observability] Unknown tool: ${tool}. Use 'langfuse', 'openlit' or 'mlflow'.`);
}

export { traceGeneration, traceSpan } from './langfuse-helpers';
