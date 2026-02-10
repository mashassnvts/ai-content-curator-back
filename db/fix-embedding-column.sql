-- Исправление типа колонки embedding: TEXT → vector(768)
-- Выполнить в Neon SQL Editor: https://console.neon.tech
-- Если видите ошибку "operator does not exist: text <=> vector"

-- Шаг 1: Убедитесь, что расширение vector установлено
CREATE EXTENSION IF NOT EXISTS vector;

-- Шаг 2: Проверяем, установлено ли расширение (должно вернуть строку с vector)
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';

-- Шаг 3: Удаляем старую колонку embedding (если она существует как TEXT)
-- ВАЖНО: Это удалит все существующие эмбеддинги, они пересоздадутся при следующем анализе
ALTER TABLE analysis_history DROP COLUMN IF EXISTS embedding;

-- Шаг 4: Создаем новую колонку с правильным типом vector(768)
ALTER TABLE analysis_history ADD COLUMN embedding vector(768);

-- Шаг 5: Проверяем, что колонка создана правильно (должно показать udt_name = 'vector')
SELECT 
    column_name,
    data_type,
    udt_name
FROM information_schema.columns
WHERE table_name = 'analysis_history' 
  AND column_name = 'embedding';
