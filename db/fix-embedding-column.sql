-- Исправление типа колонки embedding: TEXT → vector(768)
-- Выполнить в Neon SQL Editor: https://console.neon.tech
-- Если видите ошибку "operator does not exist: text <=> vector"

CREATE EXTENSION IF NOT EXISTS vector;

-- Вариант 1: Если колонка embedding уже есть как TEXT — удалить и создать заново
-- (старые эмбеддинги потеряются, они пересоздадутся при следующем анализе)
ALTER TABLE analysis_history DROP COLUMN IF EXISTS embedding;
ALTER TABLE analysis_history ADD COLUMN embedding vector(768);
