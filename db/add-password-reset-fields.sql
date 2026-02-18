-- Миграция: Добавление полей для восстановления пароля
-- Добавляет поля password_reset_token и password_reset_expires_at в таблицу users

-- Проверяем существование колонок перед добавлением
DO $$ 
BEGIN
    -- Добавляем password_reset_token если его нет
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' AND column_name = 'password_reset_token'
    ) THEN
        ALTER TABLE users ADD COLUMN password_reset_token VARCHAR(255) NULL;
    END IF;

    -- Добавляем password_reset_expires_at если его нет
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' AND column_name = 'password_reset_expires_at'
    ) THEN
        ALTER TABLE users ADD COLUMN password_reset_expires_at TIMESTAMP NULL;
    END IF;
END $$;

-- Создаем индекс для быстрого поиска по токену восстановления
CREATE INDEX IF NOT EXISTS idx_users_password_reset_token ON users(password_reset_token);
