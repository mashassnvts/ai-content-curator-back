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
import './models/User';
import './models/UserInterest';
import './models/AnalysisHistory';
import './models/BotProfile';
import './models/BotAnalysisHistory';
import './models/UserInterestLevel';
import './models/ContentRelevanceScore';
import './models/UserSemanticTag';
import TelegramChannel from './models/TelegramChannel';
import TelegramChannelPost from './models/TelegramChannelPost';
import historyCleanupService from './services/history-cleanup.service';

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
        // Используем alter: true для создания недостающих таблиц и обновления существующих
        // ВАЖНО: Колонка embedding с типом vector(768) создается вручную через SQL
        // Sequelize не поддерживает тип vector, поэтому после синхронизации проверяем и исправляем тип колонки
        try {
            await sequelize.sync({ alter: true, logging: false });
            console.log('✅ Database models synchronized successfully.');
            
            // Проверяем и исправляем тип колонки embedding после синхронизации
            // Sequelize может изменить vector на TEXT при alter: true, поэтому исправляем это
            try {
                const embeddingType = await sequelize.query(
                    `SELECT data_type, udt_name FROM information_schema.columns 
                     WHERE table_name = 'analysis_history' AND column_name = 'embedding'`,
                    { type: QueryTypes.SELECT }
                ) as any[];
                
                if (embeddingType.length > 0) {
                    if (embeddingType[0].udt_name === 'text') {
                        // НЕ пересоздаём колонку — DROP удалит все эмбеддинги!
                        // Пользователь должен вручную выполнить fix-embedding-column.sql
                        console.warn('⚠️ Column embedding is TEXT instead of vector. Run fix-embedding-column.sql manually to fix. Existing data will be preserved only if you run it once.');
                    } else if (embeddingType[0].udt_name === 'vector') {
                        console.log('✅ Column embedding has correct type: vector');
                    }
                } else {
                    // Колонка не существует - создаем её как vector(768)
                    const vectorExt = await sequelize.query(
                        `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
                        { type: QueryTypes.SELECT }
                    ) as any[];
                    
                    if (vectorExt.length > 0) {
                        await sequelize.query(`
                            ALTER TABLE analysis_history ADD COLUMN embedding vector(768);
                        `);
                        console.log('✅ Column embedding created with type: vector(768)');
                    } else {
                        console.warn('⚠️ Extension vector is not installed. Column embedding will be created as TEXT.');
                    }
                }
            } catch (embeddingError: any) {
                console.warn('⚠️ Could not check/fix embedding column type:', embeddingError.message);
                console.log('💡 Run fix-embedding-column.sql manually to fix the column type');
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
            const channelCheckIntervalHours = parseInt(process.env.TELEGRAM_CHANNEL_CHECK_INTERVAL_HOURS || '6', 10);
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
