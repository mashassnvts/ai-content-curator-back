/**
 * Observability module: Langfuse, OpenLIT, MLflow, Phoenix.
 * Переключение через OBSERVABILITY_TOOL=langfuse|openlit|mlflow|phoenix
 * Langfuse/OpenLIT/MLflow → Langfuse. Phoenix → Arize Phoenix (self-hosted, бесплатно).
 */

const tool = process.env.OBSERVABILITY_TOOL?.toLowerCase().trim();
const enabled = process.env.OBSERVABILITY_ENABLED === 'true' || process.env.OBSERVABILITY_ENABLED === '1';

console.log('[Observability] OBSERVABILITY_ENABLED=', process.env.OBSERVABILITY_ENABLED, 'OBSERVABILITY_TOOL=', process.env.OBSERVABILITY_TOOL ?? '(not set)');

if (!enabled || !tool) {
    console.log('[Observability] Disabled or missing tool. Set OBSERVABILITY_ENABLED=true and OBSERVABILITY_TOOL=langfuse, openlit, mlflow or phoenix');
} else if (tool === 'phoenix') {
    try {
        require('./phoenix');
        const url = process.env.PHOENIX_COLLECTOR_ENDPOINT || process.env.PHOENIX_URL || 'http://localhost:6006';
        console.log('[Observability] Phoenix enabled. Traces →', url, '| UI: http://localhost:6006');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[Observability] Phoenix init failed:', msg, '— Run: npm install @arizeai/phoenix-otel');
    }
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
    console.warn(`[Observability] Unknown tool: ${tool}. Use 'langfuse', 'openlit', 'mlflow' or 'phoenix'.`);
}

export { traceGeneration, traceSpan } from './langfuse-helpers';
