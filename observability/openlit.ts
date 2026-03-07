/**
 * OpenLIT: авто-инструментация через OpenTelemetry.
 * Отправляет трейсы в Langfuse OTLP или в консоль (если endpoint не задан).
 *
 * Для Langfuse Cloud (EU):
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
 *   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(LANGFUSE_PUBLIC_KEY:LANGFUSE_SECRET_KEY)>
 *
 * Для Langfuse self-hosted:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3100/api/public/otel
 */
// @ts-ignore - openlit may not have types
import Openlit from 'openlit';

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const baseUrl = process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com';

let otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
let otlpHeaders: Record<string, string> | undefined;

const headersEnv = process.env.OTEL_EXPORTER_OTLP_HEADERS;
if (headersEnv && typeof headersEnv === 'string') {
    const parsed: Record<string, string> = {};
    headersEnv.split(',').forEach((part) => {
        const idx = part.indexOf('=');
        if (idx > 0) parsed[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    });
    otlpHeaders = Object.keys(parsed).length ? parsed : undefined;
} else {
    otlpHeaders = undefined;
}

if (!otlpEndpoint && publicKey && secretKey) {
    otlpEndpoint = `${baseUrl.replace(/\/$/, '')}/api/public/otel`;
    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
    otlpHeaders = { Authorization: `Basic ${auth}` };
}

Openlit.init({
    otlpEndpoint: otlpEndpoint || undefined,
    otlpHeaders,
    disableBatch: true,
    applicationName: process.env.OTEL_SERVICE_NAME || 'ai-content-curator',
    environment: process.env.OTEL_DEPLOYMENT_ENVIRONMENT || 'development',
});

console.log('[Observability] OpenLIT initialized (auto-instrumentation)', otlpEndpoint ? `→ ${otlpEndpoint}` : '→ console');
