-- Добавление колонки extracted_themes в analysis_history
-- Хранит JSON-массив тем/смыслов, извлечённых из контента поста/статьи

ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS extracted_themes TEXT;
