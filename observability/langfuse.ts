/**
 * Langfuse: ручная инструментация, отправка в Langfuse Cloud или self-hosted.
 * Требует: LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_BASE_URL (опционально)
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

const sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
});

sdk.start();
console.log('[Observability] Langfuse initialized (manual instrumentation)');
