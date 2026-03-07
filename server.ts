import './observability';
import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { QueryTypes } from 'sequelize';
import sequelize from './config/database';
import analysisRoutes from './routes/analysis.routes';
import userRoutes from './routes/user.routes';
import feedbackRoutes from './routes/feedback.routes';
import botRoutes from './routes/bot.routes';
import relevanceLevelRoutes from './routes/relevance-level.routes';
import telegramChannelRoutes from './routes/telegram-channel.routes';
import notificationRoutes from './routes/notification.routes';
import './models/User';
import './models/UserInterest';
import './models/AnalysisHistory';
import './models/BotProfile';
import './models/BotAnalysisHistory';
import './models/UserInterestLevel';
import './models/ContentRelevanceScore';
import './models/UserSemanticTag';
import './models/AnalysisStageStats';
import TelegramChannel from './models/TelegramChannel';
import TelegramChannelPost from './models/TelegramChannelPost';
import './models/AppNotification';
import historyCleanupService from './services/history-cleanup.service';
import { initAnalysisQueue } from './services/analysis-queue.service';
import { runAnalysisInBackground } from './controllers/analysis.controller';

// Устанавливаем связи между моделями после их импорта
TelegramChannel.hasMany(TelegramChannelPost, { foreignKey: 'channelId', as: 'TelegramChannelPosts' });
import { startChannelMonitoring } from './services/telegram-channel-monitor.service';

dotenv.config();

const app: Application = express();

const PORT = parseInt(process.env.PORT || '5000', 10);

// Получаем список разрешенных origin из переменной окружения
const allowedOrigins = process.env.CORS_ORIGIN 
    ? process.env.CORS_ORIGIN.split(',').map((origin: string) => origin.trim()).filter(Boolean)
    : ['http://localhost:3000', 'http://127.0.0.1:3000'];

// Vercel preview/production домены (*.vercel.app)
const isVercelOrigin = (origin: string) => origin.endsWith('.vercel.app');

console.log('🌐 CORS allowed origins:', allowedOrigins, '+ *.vercel.app');

const corsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Разрешаем запросы без origin (например, мобильные приложения, Postman)
        if (!origin) {
            return callback(null, true);
        }
        
        // Разрешаем Vercel-домены и список из CORS_ORIGIN
        if (allowedOrigins.includes(origin) || isVercelOrigin(origin)) {
            callback(null, true);
        } else {
            console.warn(`⚠️ CORS blocked origin: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true, // Разрешаем отправку cookies
    optionsSuccessStatus: 200, // Для старых браузеров
    preflightContinue: false,
};

app.use(cors(corsOptions));

// Увеличиваем лимит размера тела запроса для больших транскриптов
app.use(express.json({ limit: '10mb' })); // Ensure JSON bodies are parsed

// Обработка закрытых соединений в middleware для парсинга JSON
app.use((err: any, req: Request, res: Response, next: any) => {
    if (err.type === 'entity.parse.failed' || err.type === 'request.aborted') {
        // Игнорируем ошибки парсинга при закрытом соединении
        if (err.code === 'ECONNABORTED' || err.message?.includes('aborted')) {
            console.log(`ℹ️ Request body parsing aborted (${req.method} ${req.path})`);
            return; // Не отправляем ответ, соединение закрыто
        }
    }
    next(err);
});

// Remove urlencoded parser if it exists, to avoid conflicts
// app.use(express.urlencoded({ extended: true })); 

app.use('/api/analysis', analysisRoutes);
app.use('/api/auth', userRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/bot', botRoutes);
app.use('/api/relevance-level', relevanceLevelRoutes);
app.use('/api/telegram-channels', telegramChannelRoutes);
app.use('/api/notifications', notificationRoutes);

app.get('/', (req: Request, res: Response) => {
    res.send('API is running...');
});

// Health check endpoint для Railway и других платформ
app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Error handling middleware (must be last)
app.use((err: any, req: Request, res: Response, next: any) => {
    // Игнорируем ошибки закрытого соединения (клиент закрыл соединение до завершения запроса)
    if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' || err.message === 'request aborted' || err.type === 'request.aborted') {
        // Соединение было закрыто клиентом или Railway - это нормально для длительных операций
        console.log(`ℹ️ Request aborted by client (${req.method} ${req.path}) - connection closed before completion`);
        // Не отправляем ответ, так как соединение уже закрыто
        return;
    }
    
    // Проверяем, не закрыто ли уже соединение перед отправкой ответа
    if (res.headersSent || res.writableEnded) {
        console.log(`ℹ️ Response already sent, skipping error handler for ${req.method} ${req.path}`);
        return;
    }
    
    console.error('Unhandled error:', err);
    if (err.stack) {
        console.error('Error stack:', err.stack);
    }
    
    // Убеждаемся, что CORS заголовки установлены даже при ошибке
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.includes(origin) || isVercelOrigin(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    }
    
    // Если это CORS ошибка, возвращаем 403
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ message: 'CORS policy violation', error: err.message });
    }
    
    res.status(500).json({ message: 'Internal server error', error: err.message });
});

const startServer = async () => {
    let dbConnected = false;
    
    // Пытаемся подключиться к БД и синхронизировать таблицы
    try {
        console.log('🔌 Connecting to database...');
        await sequelize.authenticate();
        console.log('✅ Database connection established successfully.');
        
        console.log('📊 Synchronizing database models...');
            // Используем alter: false — иначе Sequelize УДАЛЯЕТ колонку embedding при sync (её нет в модели).
        // DROP column при каждом рестарте = потеря всех эмбеддингов. alter: false сохраняет колонку.
        // Колонка embedding создаётся вручную ниже, если её ещё нет.
        try {
            await sequelize.sync({ alter: false, logging: false });
            console.log('✅ Database models synchronized successfully.');
            
            // Проверяем и создаём колонку embedding только если её нет
            // НЕ изменяем тип существующей колонки — это сохраняет данные
            try {
                const embeddingType = await sequelize.query(
                    `SELECT data_type, udt_name FROM information_schema.columns 
                     WHERE table_name = 'analysis_history' AND column_name = 'embedding'`,
                    { type: QueryTypes.SELECT }
                ) as any[];
                
                if (embeddingType.length > 0) {
                    // Колонка существует — проверяем тип
                    if (embeddingType[0].udt_name === 'vector') {
                        console.log('✅ Column embedding exists with correct type: vector(768)');
                    } else if (embeddingType[0].udt_name === 'text') {
                        // Колонка TEXT — предупреждаем, но НЕ меняем автоматически (чтобы не потерять данные)
                        console.warn('⚠️ Column embedding is TEXT instead of vector. Existing embeddings may be lost.');
                        console.warn('💡 To fix: Run fix-embedding-column.sql manually (will recreate column as vector, data will be lost).');
                    }
                } else {
                    // Колонка не существует - создаем её как vector(768) только один раз
                    const vectorExt = await sequelize.query(
                        `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
                        { type: QueryTypes.SELECT }
                    ) as any[];
                    
                    if (vectorExt.length > 0) {
                        await sequelize.query(`
                            ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS embedding vector(768);
                        `);
                        console.log('✅ Column embedding created with type: vector(768)');
                    } else {
                        console.warn('⚠️ Extension vector is not installed. Cannot create embedding column.');
                        console.warn('💡 Run: CREATE EXTENSION vector; in PostgreSQL, then restart server.');
                    }
                }
            } catch (embeddingError: any) {
                console.warn('⚠️ Could not check/create embedding column:', embeddingError.message);
                console.log('💡 Embedding column may need to be created manually via SQL');
            }
        } catch (syncError: any) {
            // Если ошибка связана с vector индексом - игнорируем (индекс создается вручную)
            if (syncError.message && syncError.message.includes('vector_cosine_ops')) {
                console.warn('⚠️ Database sync warning (vector index):', syncError.message);
                console.log('💡 Vector indexes should be created manually via SQL');
                console.log('✅ Database models synchronized (vector index skipped)');
            } else {
                throw syncError;
            }
        }
        
        // Проверяем, что расширение vector установлено
        try {
            const [results] = await sequelize.query("SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1") as any[];
            if (results && results.length > 0) {
                console.log('✅ pgvector extension is installed');
            } else {
                console.warn('⚠️ pgvector extension is not installed. Run: CREATE EXTENSION vector;');
            }
        } catch (error: any) {
            console.warn('⚠️ pgvector extension check failed:', error.message);
        }
        
        // Создаем индекс на telegramId вручную (если колонка существует)
        try {
            const queryInterface = sequelize.getQueryInterface();
            const tableDescription = await queryInterface.describeTable('analysis_history');
            if (tableDescription.telegram_id && !tableDescription.telegram_id.primaryKey) {
                // Проверяем существует ли индекс
                const indexes: any[] = await queryInterface.showIndex('analysis_history') as any[];
                const hasIndex = indexes.some((idx: any) => 
                    idx.fields && Array.isArray(idx.fields) && 
                    idx.fields.some((f: any) => f.attribute === 'telegram_id' || f === 'telegram_id')
                );
                if (!hasIndex) {
                    await queryInterface.addIndex('analysis_history', ['telegram_id'], {
                        name: 'analysis_history_telegram_id',
                        concurrently: false
                    });
                    console.log('✅ Created index on telegram_id');
                }
            }
        } catch (indexError: any) {
            // Игнорируем ошибки создания индекса (колонка может еще не существовать)
            console.log('ℹ️ Index on telegram_id will be created after column is added');
        }
        
        // Проверяем, что таблицы созданы
        const tables = await sequelize.getQueryInterface().showAllTables();
        console.log(`📋 Found ${tables.length} table(s) in database:`, tables);
        
        // Проверяем и создаем таблицу analysis_stage_stats если её нет
        const hasStageStatsTable = tables.includes('analysis_stage_stats');
        if (!hasStageStatsTable) {
            console.log('📊 Creating analysis_stage_stats table...');
            try {
                await sequelize.query(`
                    CREATE TABLE IF NOT EXISTS analysis_stage_stats (
                        id SERIAL PRIMARY KEY,
                        stage_id INT NOT NULL,
                        stage_name VARCHAR(255) NOT NULL,
                        item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('channel', 'urls', 'text', 'article', 'video')),
                        duration_ms INT NOT NULL,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    );
                    
                    CREATE INDEX IF NOT EXISTS idx_analysis_stage_stats_stage_item ON analysis_stage_stats(stage_id, item_type);
                    CREATE INDEX IF NOT EXISTS idx_analysis_stage_stats_created ON analysis_stage_stats(created_at);
                `);
                
                // Обновляем CHECK constraint если таблица уже существует
                try {
                    await sequelize.query(`
                        ALTER TABLE analysis_stage_stats DROP CONSTRAINT IF EXISTS analysis_stage_stats_item_type_check;
                        ALTER TABLE analysis_stage_stats ADD CONSTRAINT analysis_stage_stats_item_type_check 
                            CHECK (item_type IN ('channel', 'urls', 'text', 'article', 'video'));
                    `);
                } catch (constraintError: any) {
                    // Игнорируем ошибки обновления constraint (может не существовать или уже обновлен)
                    console.log('ℹ️ Could not update constraint (may already be updated):', constraintError.message);
                }
                console.log('✅ Table analysis_stage_stats created successfully');
            } catch (createError: any) {
                console.error('❌ Failed to create analysis_stage_stats table:', createError.message);
                console.warn('💡 Please run the migration script manually: add-analysis-stage-stats.sql');
            }
        } else {
            console.log('✅ Table analysis_stage_stats exists');
        }
        
        // Проверяем и добавляем колонку original_text в analysis_history если её нет
        try {
            const columns = await sequelize.query(
                `SELECT column_name FROM information_schema.columns 
                 WHERE table_name = 'analysis_history' AND column_name = 'original_text'`,
                { type: QueryTypes.SELECT }
            ) as any[];
            
            if (columns.length === 0) {
                console.log('📊 Adding original_text column to analysis_history...');
                await sequelize.query(`
                    ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS original_text TEXT;
                `);
                console.log('✅ Column original_text added to analysis_history');
            } else {
                console.log('✅ Column original_text exists in analysis_history');
            }
        } catch (columnError: any) {
            console.warn('⚠️ Could not check/add original_text column:', columnError.message);
        }
        
        // Проверяем и добавляем колонку extracted_themes в analysis_history если её нет
        try {
            const extractedThemesColumns = await sequelize.query(
                `SELECT column_name FROM information_schema.columns 
                 WHERE table_name = 'analysis_history' AND column_name = 'extracted_themes'`,
                { type: QueryTypes.SELECT }
            ) as any[];
            
            if (extractedThemesColumns.length === 0) {
                console.log('📊 Adding extracted_themes column to analysis_history...');
                await sequelize.query(`
                    ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS extracted_themes TEXT;
                `);
                console.log('✅ Column extracted_themes added to analysis_history');
            } else {
                console.log('✅ Column extracted_themes exists in analysis_history');
            }
        } catch (extractedThemesError: any) {
            console.warn('⚠️ Could not check/add extracted_themes column:', extractedThemesError.message);
        }
        
        // Проверяем и создаем таблицу qa_history если её нет
        const hasQAHistoryTable = tables.includes('qa_history');
        if (!hasQAHistoryTable) {
            console.log('📊 Creating qa_history table...');
            try {
                await sequelize.query(`
                    CREATE TABLE IF NOT EXISTS qa_history (
                        id SERIAL PRIMARY KEY,
                        analysis_history_id INT REFERENCES analysis_history(id) ON DELETE CASCADE,
                        url TEXT NOT NULL,
                        question TEXT NOT NULL,
                        answer TEXT NOT NULL,
                        user_id INT REFERENCES users(id) ON DELETE SET NULL,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    );
                    
                    CREATE INDEX IF NOT EXISTS idx_qa_history_analysis ON qa_history(analysis_history_id);
                    CREATE INDEX IF NOT EXISTS idx_qa_history_url ON qa_history(url);
                    CREATE INDEX IF NOT EXISTS idx_qa_history_user ON qa_history(user_id);
                    CREATE INDEX IF NOT EXISTS idx_qa_history_created ON qa_history(created_at);
                `);
                console.log('✅ Table qa_history created successfully');
            } catch (createError: any) {
                console.error('❌ Failed to create qa_history table:', createError.message);
                console.warn('💡 Please run the migration script manually: add-qa-history.sql');
            }
        } else {
            console.log('✅ Table qa_history exists');
        }
        
        // Проверяем и создаем таблицу app_notifications если её нет
        const hasAppNotificationsTable = tables.includes('app_notifications');
        if (!hasAppNotificationsTable) {
            console.log('📊 Creating app_notifications table...');
            try {
                await sequelize.query(`
                    CREATE TABLE IF NOT EXISTS app_notifications (
                        id SERIAL PRIMARY KEY,
                        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        message TEXT NOT NULL,
                        channel_username VARCHAR(255) NOT NULL,
                        analyzed_count INT NOT NULL DEFAULT 0,
                        read BOOLEAN NOT NULL DEFAULT false,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    );
                    CREATE INDEX IF NOT EXISTS idx_app_notifications_user ON app_notifications(user_id);
                    CREATE INDEX IF NOT EXISTS idx_app_notifications_read ON app_notifications(read);
                `);
                console.log('✅ Table app_notifications created successfully');
            } catch (createError: any) {
                console.warn('⚠️ Could not create app_notifications table:', (createError as Error).message);
            }
        } else {
            console.log('✅ Table app_notifications exists');
        }
        
        // Проверяем и добавляем поля для восстановления пароля в users если их нет
        try {
            const passwordResetColumns = await sequelize.query(
                `SELECT column_name FROM information_schema.columns 
                 WHERE table_name = 'users' AND column_name IN ('password_reset_token', 'password_reset_expires_at')`,
                { type: QueryTypes.SELECT }
            ) as any[];
            
            const hasPasswordResetToken = passwordResetColumns.some((col: any) => col.column_name === 'password_reset_token');
            const hasPasswordResetExpires = passwordResetColumns.some((col: any) => col.column_name === 'password_reset_expires_at');
            
            if (!hasPasswordResetToken || !hasPasswordResetExpires) {
                console.log('📊 Adding password reset fields to users table...');
                if (!hasPasswordResetToken) {
                    await sequelize.query(`
                        ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(255) NULL;
                    `);
                    console.log('✅ Column password_reset_token added to users');
                }
                if (!hasPasswordResetExpires) {
                    await sequelize.query(`
                        ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMP NULL;
                    `);
                    console.log('✅ Column password_reset_expires_at added to users');
                }
                
                // Создаем индекс для быстрого поиска по токену
                try {
                    await sequelize.query(`
                        CREATE INDEX IF NOT EXISTS idx_users_password_reset_token ON users(password_reset_token);
                    `);
                    console.log('✅ Index on password_reset_token created');
                } catch (indexError: any) {
                    console.log('ℹ️ Index on password_reset_token may already exist');
                }
            } else {
                console.log('✅ Password reset fields exist in users table');
            }
        } catch (passwordResetError: any) {
            console.warn('⚠️ Could not check/add password reset fields:', passwordResetError.message);
            console.warn('💡 Please run the migration script manually: add-password-reset-fields.sql');
        }
        
        dbConnected = true;
    } catch (error: any) {
        console.error('❌ Database connection/sync error:', error.message);
        if (error.stack) {
            console.error('   Stack:', error.stack);
        }
        console.warn('⚠️ Server will start without database connection. Some features may not work.');
        console.warn('💡 Tip: Check that DATABASE_URL is correct and PostgreSQL service is running.');
        dbConnected = false;
    }

    // Инициализируем очередь анализа (Bull + Redis) для параллельной обработки нескольких пользователей
    initAnalysisQueue((data) => runAnalysisInBackground(data.jobId, data.urlInput, data.interests, data.analysisMode, data.userId));

    // Запускаем сервер независимо от результата подключения к БД
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server is running on port ${PORT}`);
        console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
        
        // Увеличиваем таймауты для длительных операций (анализ видео может занимать несколько минут)
        server.keepAliveTimeout = 300000; // 5 минут для keep-alive соединений
        server.headersTimeout = 310000; // 5 минут 10 секунд для заголовков (должен быть больше keepAliveTimeout)
        console.log(`⏱️ Server timeouts configured: keepAliveTimeout=${server.keepAliveTimeout}ms, headersTimeout=${server.headersTimeout}ms`);
        
        // Запускаем периодическую очистку истории только если БД подключена
        if (dbConnected) {
            const cleanupIntervalHours = parseInt(process.env.HISTORY_CLEANUP_INTERVAL_HOURS || '48', 10);
            console.log(`🔄 Starting periodic history cleanup (every ${cleanupIntervalHours} hours)...`);
            historyCleanupService.startPeriodicCleanup(cleanupIntervalHours);

            // Запускаем мониторинг Telegram-каналов
            const channelCheckIntervalHours = parseInt(process.env.TELEGRAM_CHANNEL_CHECK_INTERVAL_HOURS || '4', 10);
            const enableChannelMonitoring = process.env.ENABLE_TELEGRAM_CHANNEL_MONITORING === 'true';
            if (enableChannelMonitoring) {
                console.log(`📢 Starting Telegram channel monitoring (every ${channelCheckIntervalHours} hours)...`);
                startChannelMonitoring(channelCheckIntervalHours);
            } else {
                console.log('⏭️ Telegram channel monitoring disabled (ENABLE_TELEGRAM_CHANNEL_MONITORING!=true)');
            }
        } else {
            console.warn('⏭️ Skipping history cleanup and channel monitoring: database not connected');
        }
    });
    
    // Запускаем Telegram бота после запуска сервера (если не отключен)
    const disableBot = process.env.DISABLE_BOT === 'true';
    const enableBot = process.env.ENABLE_BOT === 'true';
    if (!disableBot && enableBot) {
        // Даем серверу время на запуск, затем запускаем бота
        setTimeout(() => {
            console.log('🤖 Starting Telegram bot after server initialization...');
            try {
                // Загружаем бота асинхронно, чтобы ошибки не останавливали сервер
                import('./bot-runner').catch((error: any) => {
                    console.error('⚠️ Failed to start Telegram bot:', error.message);
                    if (error.stack) {
                        console.error('   Stack:', error.stack);
                    }
                    console.log('   Bot will not be available, but server is running.');
                });
            } catch (error: any) {
                console.error('⚠️ Failed to load Telegram bot:', error.message);
                console.log('   Bot will not be available, but server is running.');
            }
        }, 3000); // 3 секунды на запуск сервера
    } else {
        if (disableBot) {
            console.log('⏭️ Telegram bot disabled (DISABLE_BOT=true)');
        } else {
            console.log('⏭️ Telegram bot disabled (ENABLE_BOT!=true)');
        }
    }
};

startServer();
