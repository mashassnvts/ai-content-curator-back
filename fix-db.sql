-- Исправление БД: добавление недостающих колонок
-- Выполните эти команды в PostgreSQL перед запуском сервера

-- Добавляем колонку is_active в user_interests
ALTER TABLE user_interests 
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- Добавляем колонку telegram_id в analysis_history
ALTER TABLE analysis_history 
ADD COLUMN IF NOT EXISTS telegram_id VARCHAR(255);

-- Создаем индексы (если их еще нет)
CREATE INDEX IF NOT EXISTS idx_user_interests_is_active 
ON user_interests(is_active);

CREATE INDEX IF NOT EXISTS idx_analysis_history_telegram_id 
ON analysis_history(telegram_id);

-- Обновляем существующие записи: все интересы по умолчанию активны
UPDATE user_interests 
SET is_active = TRUE 
WHERE is_active IS NULL;

