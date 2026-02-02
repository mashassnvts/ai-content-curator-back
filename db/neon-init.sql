-- ============================================
-- ПОЛНАЯ ИНИЦИАЛИЗАЦИЯ БД ДЛЯ NEON
-- Выполните в Neon SQL Editor: https://console.neon.tech
-- ============================================

-- 1. Расширение pgvector (для поиска похожих статей)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Таблица пользователей
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Профиль пользователя
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    interests TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Интересы пользователя
CREATE TABLE IF NOT EXISTS user_interests (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interest VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, interest)
);
CREATE INDEX IF NOT EXISTS idx_user_interests_user ON user_interests(user_id);
CREATE INDEX IF NOT EXISTS idx_user_interests_is_active ON user_interests(is_active);

-- 5. История анализов (с колонкой embedding для векторного поиска)
CREATE TABLE IF NOT EXISTS analysis_history (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    telegram_id VARCHAR(255),
    url TEXT NOT NULL,
    interests TEXT,
    source_type VARCHAR(50),
    score INT,
    verdict VARCHAR(100),
    summary TEXT,
    reasoning TEXT,
    embedding vector(768),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analysis_history_user ON analysis_history(user_id);
CREATE INDEX IF NOT EXISTS idx_analysis_history_telegram ON analysis_history(telegram_id);
CREATE INDEX IF NOT EXISTS idx_analysis_history_created ON analysis_history(created_at);

-- 6. Обратная связь от пользователя
CREATE TABLE IF NOT EXISTS user_feedback (
    id SERIAL PRIMARY KEY,
    history_id INT NOT NULL REFERENCES analysis_history(id) ON DELETE CASCADE,
    user_rating BOOLEAN NOT NULL,
    user_comment TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. ENUM для уровней интересов
DO $$ BEGIN
    CREATE TYPE enum_user_interest_levels_level AS ENUM ('novice', 'amateur', 'professional');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 8. Уровни пользователя по интересам
CREATE TABLE IF NOT EXISTS user_interest_levels (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interest VARCHAR(255) NOT NULL,
    level enum_user_interest_levels_level NOT NULL DEFAULT 'novice',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, interest)
);

-- 9. Оценки релевантности контента
CREATE TABLE IF NOT EXISTS content_relevance_scores (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interest VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    content_level VARCHAR(20) NOT NULL,
    relevance_score INT NOT NULL,
    explanation TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, interest, url)
);

-- 10. Семантические теги пользователя (облако смыслов)
CREATE TABLE IF NOT EXISTS user_semantic_tags (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag VARCHAR(255) NOT NULL,
    weight DECIMAL(10, 2) NOT NULL DEFAULT 1.0,
    last_used TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_user_semantic_tags_user ON user_semantic_tags(user_id);
CREATE INDEX IF NOT EXISTS idx_user_semantic_tags_tag ON user_semantic_tags(tag);

-- 11. ENUM для режима бота
DO $$ BEGIN
    CREATE TYPE enum_bot_profiles_mode AS ENUM ('guest', 'linked');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 12. Профили Telegram-бота
CREATE TABLE IF NOT EXISTS bot_profiles (
    id SERIAL PRIMARY KEY,
    telegram_id VARCHAR(255) NOT NULL UNIQUE,
    telegram_username VARCHAR(255),
    telegram_chat_id VARCHAR(255),
    mode enum_bot_profiles_mode NOT NULL DEFAULT 'guest',
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    guest_interests TEXT,
    guest_active_interests TEXT,
    guest_levels TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 13. История анализов через бота
CREATE TABLE IF NOT EXISTS bot_analysis_history (
    id SERIAL PRIMARY KEY,
    telegram_id VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    interests TEXT NOT NULL,
    source_type VARCHAR(50),
    score INT,
    verdict VARCHAR(100),
    summary TEXT,
    reasoning TEXT,
    user_id INT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bot_analysis_telegram ON bot_analysis_history(telegram_id);
CREATE INDEX IF NOT EXISTS idx_bot_analysis_user ON bot_analysis_history(user_id);

-- 14. Telegram-каналы для мониторинга
CREATE TABLE IF NOT EXISTS telegram_channels (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_username VARCHAR(255) NOT NULL,
    channel_id BIGINT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_checked_at TIMESTAMP WITH TIME ZONE,
    last_post_message_id BIGINT,
    check_frequency VARCHAR(20) DEFAULT 'daily',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel_username)
);
CREATE INDEX IF NOT EXISTS idx_telegram_channels_active ON telegram_channels(is_active, last_checked_at);

-- 15. Посты из Telegram-каналов
CREATE TABLE IF NOT EXISTS telegram_channel_posts (
    id SERIAL PRIMARY KEY,
    channel_id INT NOT NULL REFERENCES telegram_channels(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL,
    post_url TEXT,
    post_text TEXT,
    analysis_history_id INT REFERENCES analysis_history(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_channel_posts_channel ON telegram_channel_posts(channel_id, message_id);

-- 16. Добавляем недостающие колонки в analysis_history (если таблица уже существовала)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analysis_history' AND column_name = 'telegram_id') THEN
        ALTER TABLE analysis_history ADD COLUMN telegram_id VARCHAR(255);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analysis_history' AND column_name = 'interests') THEN
        ALTER TABLE analysis_history ADD COLUMN interests TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analysis_history' AND column_name = 'source_type') THEN
        ALTER TABLE analysis_history ADD COLUMN source_type VARCHAR(50);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analysis_history' AND column_name = 'verdict') THEN
        ALTER TABLE analysis_history ADD COLUMN verdict VARCHAR(100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analysis_history' AND column_name = 'summary') THEN
        ALTER TABLE analysis_history ADD COLUMN summary TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analysis_history' AND column_name = 'embedding') THEN
        ALTER TABLE analysis_history ADD COLUMN embedding vector(768);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analysis_history' AND column_name = 'updated_at') THEN
        ALTER TABLE analysis_history ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Some columns may already exist: %', SQLERRM;
END $$;

-- ============================================
-- ГОТОВО
-- ============================================
-- Проверка: SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
