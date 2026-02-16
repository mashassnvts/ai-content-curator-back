-- Обновление таблицы analysis_stage_stats для поддержки типов 'article' и 'video'
-- Выполнить в Neon SQL Editor: https://console.neon.tech

-- Обновляем CHECK constraint для поддержки новых типов
ALTER TABLE analysis_stage_stats DROP CONSTRAINT IF EXISTS analysis_stage_stats_item_type_check;
ALTER TABLE analysis_stage_stats ADD CONSTRAINT analysis_stage_stats_item_type_check 
    CHECK (item_type IN ('channel', 'urls', 'text', 'article', 'video'));

-- Обновляем существующие записи: если это URL и есть этап транскрипта (stage_id=1) с duration_ms > 1000, 
-- то это видео, иначе статья (но это приблизительно, лучше оставить как есть и новые записи будут правильными)
-- Можно оставить старые записи как 'urls' или обновить их вручную при необходимости
