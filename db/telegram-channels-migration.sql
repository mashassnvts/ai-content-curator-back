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
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel_id, message_id) -- Один пост не может быть обработан дважды для одного канала
);

-- Индекс для быстрого поиска постов канала
CREATE INDEX IF NOT EXISTS idx_telegram_channel_posts_channel ON telegram_channel_posts(channel_id, message_id);
