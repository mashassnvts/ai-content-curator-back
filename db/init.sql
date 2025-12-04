-- Таблица пользователей
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Профиль пользователя для хранения его интересов
CREATE TABLE user_profiles (
    user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    interests TEXT, -- Основной промпт с интересами пользователя
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- История анализов, связанных с пользователем
CREATE TABLE analysis_history (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    content_summary TEXT,
    score INT, -- Оценка релевантности от 0 до 100
    reasoning TEXT, -- Объяснение оценки
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Обратная связь от пользователя на анализ
CREATE TABLE user_feedback (
    id SERIAL PRIMARY KEY,
    history_id INT NOT NULL REFERENCES analysis_history(id) ON DELETE CASCADE,
    user_rating BOOLEAN NOT NULL, -- TRUE, если оценка верна, FALSE - если нет
    user_comment TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Уровни пользователя по интересам (для анализа релевантности контента)
-- Создаем ENUM тип для уровней
DO $$ BEGIN
    CREATE TYPE enum_user_interest_levels_level AS ENUM ('beginner', 'intermediate', 'advanced', 'expert');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS user_interest_levels (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interest VARCHAR(255) NOT NULL,
    level enum_user_interest_levels_level NOT NULL DEFAULT 'beginner',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, interest)
);





















