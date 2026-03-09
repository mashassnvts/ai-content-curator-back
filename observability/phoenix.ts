/**
 * Arize Phoenix: LLM observability (self-hosted, бесплатно).
 * OTel-трейсы отправляются в Phoenix (localhost:6006 или Phoenix Cloud).
 *
 * Запуск Phoenix локально:
 *   docker run -p 6006:6006 -p 4317:4317 arizephoenix/phoenix:latest
 * или: pip install arize-phoenix && phoenix serve
 *
 * UI: http://localhost:6006
 */
// @ts-ignore - phoenix-otel may not have full types
const { register } = require('@arizeai/phoenix-otel');

const projectName = process.env.PHOENIX_PROJECT_NAME || 'ai-content-curator';
const url = process.env.PHOENIX_COLLECTOR_ENDPOINT || process.env.PHOENIX_URL || 'http://localhost:6006';
const apiKey = process.env.PHOENIX_API_KEY;
const batch = process.env.PHOENIX_BATCH !== 'false';

register({
    projectName,
    url,
    apiKey: apiKey || undefined,
    batch,
});

console.log('[Observability] Phoenix initialized. Traces →', url);
