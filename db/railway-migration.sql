-- ============================================
-- МИГРАЦИЯ ДЛЯ RAILWAY БД
-- Выполните этот SQL в Railway PostgreSQL через pgAdmin или psql
-- ============================================

-- 1. Создание таблиц для Telegram-каналов
-- ============================================

-- Таблица для хранения Telegram-каналов пользователей
CREATE TABLE IF NOT EXISTS telegram_channels (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_username VARCHAR(255) NOT NULL, -- Например, "ai_news" (без @)
    channel_id BIGINT, -- ID канала в Telegram (если доступен)
    is_active BOOLEAN NOT NULL DEFAULT true, -- Активен ли мониторинг канала
    last_checked_at TIMESTAMP WITH TIME ZONE, -- Когда последний раз проверяли канал
    last_post_message_id BIGINT, -- ID последнего обработанного поста
    check_frequency VARCHAR(20) DEFAULT 'daily', -- Частота проверки: 'daily' или 'weekly'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel_username) -- Один пользователь не может добавить один канал дважды
);

-- Индекс для быстрого поиска активных каналов
CREATE INDEX IF NOT EXISTS idx_telegram_channels_active ON telegram_channels(is_active, last_checked_at);

-- Таблица для хранения обработанных постов из каналов (чтобы не анализировать дважды)
CREATE TABLE IF NOT EXISTS telegram_channel_posts (
    id SERIAL PRIMARY KEY,
    channel_id INT NOT NULL REFERENCES telegram_channels(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL, -- ID сообщения в Telegram
    post_url TEXT, -- URL поста (если есть)
    post_text TEXT, -- Текст поста
    analysis_history_id INT REFERENCES analysis_history(id) ON DELETE SET NULL, -- Связь с анализом
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, -- Важно: эта колонка могла отсутствовать
    UNIQUE(channel_id, message_id) -- Один пост не может быть обработан дважды для одного канала
);

-- Индекс для быстрого поиска постов канала
CREATE INDEX IF NOT EXISTS idx_telegram_channel_posts_channel ON telegram_channel_posts(channel_id, message_id);

-- 2. Проверка и добавление недостающих колонок в существующие таблицы
-- ============================================

-- Добавляем колонку updated_at в telegram_channel_posts (если её нет)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'telegram_channel_posts' 
        AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE telegram_channel_posts 
        ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
        RAISE NOTICE 'Added updated_at column to telegram_channel_posts';
    ELSE
        RAISE NOTICE 'Column updated_at already exists in telegram_channel_posts';
    END IF;
END $$;

-- Добавляем колонку is_active в user_interests (если её нет)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_interests' 
        AND column_name = 'is_active'
    ) THEN
        ALTER TABLE user_interests 
        ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
        
        -- Обновляем существующие записи: все интересы по умолчанию активны
        UPDATE user_interests 
        SET is_active = TRUE 
        WHERE is_active IS NULL;
        
        RAISE NOTICE 'Added is_active column to user_interests';
    ELSE
        RAISE NOTICE 'Column is_active already exists in user_interests';
    END IF;
END $$;

-- Добавляем колонку telegram_id в analysis_history (если её нет)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'analysis_history' 
        AND column_name = 'telegram_id'
    ) THEN
        ALTER TABLE analysis_history 
        ADD COLUMN telegram_id VARCHAR(255);
        RAISE NOTICE 'Added telegram_id column to analysis_history';
    ELSE
        RAISE NOTICE 'Column telegram_id already exists in analysis_history';
    END IF;
END $$;

-- 3. Создание индексов (если их еще нет)
-- ============================================

CREATE INDEX IF NOT EXISTS idx_user_interests_is_active 
ON user_interests(is_active);

CREATE INDEX IF NOT EXISTS idx_analysis_history_telegram_id 
ON analysis_history(telegram_id);

-- 4. Проверка расширения pgvector (для векторного поиска)
-- ============================================

CREATE EXTENSION IF NOT EXISTS vector;

-- Проверяем, есть ли колонка embedding в analysis_history
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'analysis_history' 
        AND column_name = 'embedding'
    ) THEN
        -- Добавляем колонку embedding типа vector(768)
        ALTER TABLE analysis_history 
        ADD COLUMN embedding vector(768);
        RAISE NOTICE 'Added embedding column to analysis_history';
    ELSE
        RAISE NOTICE 'Column embedding already exists in analysis_history';
    END IF;
END $$;

-- ============================================
-- МИГРАЦИЯ ЗАВЕРШЕНА
-- ============================================
-- Проверьте результат выполнения:
-- SELECT table_name FROM information_schema.tables 
-- WHERE table_schema = 'public' 
-- AND table_name IN ('telegram_channels', 'telegram_channel_posts')
-- ORDER BY table_name;
-- ============================================
