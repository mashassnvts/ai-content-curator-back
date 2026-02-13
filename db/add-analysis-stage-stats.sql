-- Создание таблицы для статистики времени этапов анализа
-- Выполнить в Neon SQL Editor: https://console.neon.tech

CREATE TABLE IF NOT EXISTS analysis_stage_stats (
    id SERIAL PRIMARY KEY,
    stage_id INT NOT NULL,
    stage_name VARCHAR(255) NOT NULL,
    item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('channel', 'urls', 'text')),
    duration_ms INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_analysis_stage_stats_stage_item ON analysis_stage_stats(stage_id, item_type);
CREATE INDEX IF NOT EXISTS idx_analysis_stage_stats_created ON analysis_stage_stats(created_at);

-- Добавление колонки original_text в таблицу analysis_history (если еще не добавлена)
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS original_text TEXT;
