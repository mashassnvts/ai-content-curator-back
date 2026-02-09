import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET as string;

export interface AuthenticatedRequest extends Request {
    user?: {
        userId: number;
    };
}

export const authMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.header('Authorization');
    const token = authHeader?.replace('Bearer ', '');

    if (!token) {
        console.warn('⚠️ No token provided in Authorization header');
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    if (!JWT_SECRET) {
        console.error('❌ JWT_SECRET is not set in environment variables');
        return res.status(500).json({ message: 'Server configuration error.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };
        req.user = decoded;
        // Убираем избыточное логирование - проверка токена происходит при каждом запросе
        // console.log(`✓ Token verified for user ${decoded.userId}`);
        next();
    } catch (error: any) {
        // Истекшие токены - это нормальная ситуация, не логируем как ошибку
        if (error.name === 'TokenExpiredError') {
            // Логируем только на уровне info, не error
            if (process.env.LOG_LEVEL === 'debug') {
                console.log('ℹ️ Token expired (user needs to login again)');
            }
            return res.status(400).json({ message: 'Token expired. Please login again.' });
        }
        
        // Для других ошибок логируем как обычно
        console.error('❌ Token verification failed:', error.message);
        if (process.env.LOG_LEVEL === 'debug') {
            console.error('Token (first 20 chars):', token.substring(0, 20) + '...');
        }
        
        let errorMessage = 'Invalid token.';
        if (error.name === 'JsonWebTokenError') {
            errorMessage = 'Invalid token format.';
        }
        
        res.status(400).json({ message: errorMessage });
    }
};
