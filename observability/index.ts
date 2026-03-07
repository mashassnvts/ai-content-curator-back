/**
 * Observability module: Langfuse и OpenLIT.
 * Переключение через OBSERVABILITY_TOOL=langfuse|openlit
 * Оба могут отправлять трейсы в Langfuse (Cloud или self-hosted).
 */

const tool = process.env.OBSERVABILITY_TOOL?.toLowerCase();
const enabled = process.env.OBSERVABILITY_ENABLED === 'true' || process.env.OBSERVABILITY_ENABLED === '1';

if (!enabled || !tool) {
    if (process.env.LOG_LEVEL === 'debug') {
        console.log('[Observability] Disabled. Set OBSERVABILITY_ENABLED=true and OBSERVABILITY_TOOL=langfuse|openlit');
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
    try { require('./openlit'); } catch (e) { console.warn('[Observability] OpenLIT init failed. Run: npm install openlit'); }
} else {
    console.warn(`[Observability] Unknown tool: ${tool}. Use 'langfuse' or 'openlit'.`);
}

export { traceGeneration, traceSpan } from './langfuse-helpers';
