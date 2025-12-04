import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import sequelize from './config/database';
import analysisRoutes from './routes/analysis.routes';
import userRoutes from './routes/user.routes';
import feedbackRoutes from './routes/feedback.routes';
import botRoutes from './routes/bot.routes';
import relevanceLevelRoutes from './routes/relevance-level.routes';
import './models/User';
import './models/UserInterest';
import './models/AnalysisHistory';
import './models/BotProfile';
import './models/BotAnalysisHistory';
import './models/UserInterestLevel';
import './models/ContentRelevanceScore';
import historyCleanupService from './services/history-cleanup.service';

dotenv.config();

const app: Application = express();

const PORT = parseInt(process.env.PORT || '5000', 10);

const corsOptions = {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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

app.get('/', (req: Request, res: Response) => {
    res.send('API is running...');
});

// Error handling middleware (must be last)
app.use((err: any, req: Request, res: Response, next: any) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ message: 'Internal server error', error: err.message });
});

const startServer = async () => {
    // Пытаемся подключиться к БД с таймаутом
    const dbConnectPromise = sequelize.authenticate()
        .then(() => {
            console.log('Database connection established successfully.');
            return sequelize.sync({ alter: true });
        })
        .then(() => {
            console.log('Database models synchronized successfully.');
        })
        .catch((error) => {
            console.error('Database connection/sync error:', error);
            console.warn('Server will start without database connection. Some features may not work.');
        });

    // Запускаем сервер независимо от результата подключения к БД
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server is running on port ${PORT}`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
        
        // Запускаем периодическую очистку истории (каждые 24 часа)
        const cleanupIntervalHours = parseInt(process.env.HISTORY_CLEANUP_INTERVAL_HOURS || '24', 10);
        historyCleanupService.startPeriodicCleanup(cleanupIntervalHours);
    });

    // Ждем подключения к БД (но не блокируем запуск сервера)
    await dbConnectPromise;
};

startServer();
