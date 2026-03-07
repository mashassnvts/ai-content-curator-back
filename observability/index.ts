/**
 * Observability module: Langfuse, OpenLIT, MLflow.
 * Переключение через OBSERVABILITY_TOOL=langfuse|openlit|mlflow
 * Langfuse и OpenLIT отправляют трейсы в Langfuse; MLflow — в MLflow Tracking Server.
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
    const raw = (process.env.MLFLOW_TRACKING_URI || 'http://localhost:5000').trim().replace(/\/+$/, '');
    const displayUri = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    console.log('[Observability] MLflow enabled. Runs will be logged to', displayUri);
} else {
    console.warn(`[Observability] Unknown tool: ${tool}. Use 'langfuse', 'openlit' or 'mlflow'.`);
}

export { traceGeneration, traceSpan } from './langfuse-helpers';
