import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

const dbUri = process.env.DATABASE_URL;

if (!dbUri) {
    throw new Error('DATABASE_URL is not defined in environment variables. Please set it in Railway/Render environment variables or .env file.');
}

// Проверяем, что DATABASE_URL содержит имя БД
// Поддерживаем формат с портом и без порта (по умолчанию 5432)
const urlMatch = dbUri.match(/postgresql:\/\/([^:]+):([^@]+)@([^:\/]+)(?::(\d+))?\/(.+)/);
if (!urlMatch) {
    throw new Error('Invalid DATABASE_URL format');
}

const [, username, password, host, port, database] = urlMatch;
const dbPort = port || '5432';

console.log(`[DB Config] DATABASE_URL: ${dbUri.replace(/:[^:@]+@/, ':****@')}`);
console.log(`[DB Config] Parsed - database: ${database}, host: ${host}, port: ${dbPort}, user: ${username}`);

// Используем полный DATABASE_URL напрямую - Sequelize правильно его парсит
const sequelize = new Sequelize(dbUri, {
    dialect: 'postgres',
    logging: false,
    // Увеличиваем таймауты подключения для Railway/Neon
    pool: {
        max: 5,
        min: 0,
        acquire: 60000, // 60 секунд на установку соединения
        idle: 10000, // 10 секунд простоя перед закрытием
    },
    // Явно указываем, что не нужно использовать имя пользователя как имя БД
    dialectOptions: {
        // SSL для Render PostgreSQL и других облачных провайдеров
        ssl: process.env.DATABASE_URL?.includes('render.com') || process.env.DATABASE_URL?.includes('railway.app') || process.env.DATABASE_URL?.includes('amazonaws.com') || process.env.DATABASE_URL?.includes('heroku.com') || process.env.DATABASE_URL?.includes('neon.tech') || process.env.DATABASE_URL?.includes('supabase.com')
            ? {
                require: true,
                rejectUnauthorized: false // Для Render PostgreSQL
            }
            : false,
        // Увеличиваем таймаут подключения для pg библиотеки
        connectTimeout: 30000, // 30 секунд
    },
});

export default sequelize;
