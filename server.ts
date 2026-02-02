import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
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
    ? process.env.CORS_ORIGIN.split(',').map((origin: string) => origin.trim())
    : ['http://localhost:3000', 'http://127.0.0.1:3000'];

console.log('🌐 CORS allowed origins:', allowedOrigins);

const corsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Разрешаем запросы без origin (например, мобильные приложения, Postman)
        if (!origin) {
            return callback(null, true);
        }
        
        // Проверяем, есть ли origin в списке разрешенных
        if (allowedOrigins.includes(origin)) {
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
app.use(express.json()); // Ensure JSON bodies are parsed

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

// Error handling middleware (must be last)
app.use((err: any, req: Request, res: Response, next: any) => {
    console.error('Unhandled error:', err);
    console.error('Error stack:', err.stack);
    
    // Убеждаемся, что CORS заголовки установлены даже при ошибке
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
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
        // НО: не создаем индексы для vector полей (они создаются вручную через SQL)
        try {
            await sequelize.sync({ alter: true, logging: false });
            console.log('✅ Database models synchronized successfully.');
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
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server is running on port ${PORT}`);
        console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
        
        // Запускаем периодическую очистку истории только если БД подключена
        if (dbConnected) {
            const cleanupIntervalHours = parseInt(process.env.HISTORY_CLEANUP_INTERVAL_HOURS || '48', 10);
            console.log(`🔄 Starting periodic history cleanup (every ${cleanupIntervalHours} hours)...`);
            historyCleanupService.startPeriodicCleanup(cleanupIntervalHours);

            // Запускаем мониторинг Telegram-каналов
            const channelCheckIntervalHours = parseInt(process.env.TELEGRAM_CHANNEL_CHECK_INTERVAL_HOURS || '6', 10);
            console.log(`📢 Starting Telegram channel monitoring (every ${channelCheckIntervalHours} hours)...`);
            startChannelMonitoring(channelCheckIntervalHours);
        } else {
            console.warn('⏭️ Skipping history cleanup and channel monitoring: database not connected');
        }
    });
    
    // Запускаем Telegram бота после запуска сервера (если не отключен)
    const disableBot = process.env.DISABLE_BOT === 'true';
    if (!disableBot) {
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
        console.log('⏭️ Telegram bot disabled (DISABLE_BOT=true)');
    }
};

startServer();
