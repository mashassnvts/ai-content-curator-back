-- Создание таблицы для истории вопросов и ответов по анализу контента
-- Выполнить в Neon SQL Editor: https://console.neon.tech

CREATE TABLE IF NOT EXISTS qa_history (
    id SERIAL PRIMARY KEY,
    analysis_history_id INT REFERENCES analysis_history(id) ON DELETE CASCADE,
    url TEXT NOT NULL, -- URL или text:// для связи с анализом (даже если нет analysis_history_id)
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    user_id INT REFERENCES users(id) ON DELETE SET NULL, -- Для авторизованных пользователей
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_qa_history_analysis ON qa_history(analysis_history_id);
CREATE INDEX IF NOT EXISTS idx_qa_history_url ON qa_history(url);
CREATE INDEX IF NOT EXISTS idx_qa_history_user ON qa_history(user_id);
CREATE INDEX IF NOT EXISTS idx_qa_history_created ON qa_history(created_at);
