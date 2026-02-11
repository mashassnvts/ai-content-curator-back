-- Исправление типа колонки embedding: TEXT → vector(768)
-- Выполнить в Neon SQL Editor: https://console.neon.tech
-- ВАЖНО: В Neon расширение vector может быть недоступно или требовать активации

-- Шаг 1: Проверяем, доступно ли расширение vector
-- Если этот запрос вернет ошибку "extension does not exist" - расширение недоступно в Neon
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';

-- Шаг 2: Пытаемся установить расширение vector
-- ВАЖНО: В Neon это может не работать, если расширение не включено в проекте
CREATE EXTENSION IF NOT EXISTS vector;

-- Шаг 3: Проверяем, что расширение установлено (должно вернуть строку)
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';

-- Шаг 4: Проверяем текущий тип колонки (если она существует)
SELECT 
    column_name,
    data_type,
    udt_name
FROM information_schema.columns
WHERE table_name = 'analysis_history' 
  AND column_name = 'embedding';

-- Шаг 5: Удаляем старую колонку embedding (если она существует)
-- ВАЖНО: Это удалит все существующие эмбеддинги, они пересоздадутся при следующем анализе
ALTER TABLE analysis_history DROP COLUMN IF EXISTS embedding;

-- Шаг 6: Проверяем, что тип vector доступен (должно вернуть 'vector')
SELECT typname FROM pg_type WHERE typname = 'vector';

-- Шаг 7: Создаем новую колонку с правильным типом vector(768)
-- ВАЖНО: Если расширение vector не установлено, эта команда создаст колонку как text!
ALTER TABLE analysis_history ADD COLUMN embedding vector(768);

-- Шаг 8: Проверяем, что колонка создана правильно
-- ОЖИДАЕМЫЙ РЕЗУЛЬТАТ: udt_name = 'vector', data_type = 'USER-DEFINED'
-- ЕСЛИ udt_name = 'text' - расширение vector не установлено!
SELECT 
    column_name,
    data_type,
    udt_name,
    (SELECT typname FROM pg_type WHERE oid = (
        SELECT atttypid FROM pg_attribute 
        WHERE attrelid = 'analysis_history'::regclass 
        AND attname = 'embedding'
    )) as actual_type
FROM information_schema.columns
WHERE table_name = 'analysis_history' 
  AND column_name = 'embedding';
