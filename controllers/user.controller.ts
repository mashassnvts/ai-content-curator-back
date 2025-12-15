import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User';
import dotenv from 'dotenv';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import UserInterest from '../models/UserInterest';
import UserService from '../services/user.service';
import { CreateUserDTO, LoginUserDTO } from '../interfaces/user.interface';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET as string;

if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in the environment variables');
}

class UserController {
    async register(req: Request, res: Response): Promise<void> {
        try {
            const userData: CreateUserDTO = req.body;
            
            // Валидация входных данных
            if (!userData.email || !userData.password || !userData.name) {
                res.status(400).json({ message: 'Все поля обязательны для заполнения' });
                return;
            }
            
            // Проверка формата email
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(userData.email)) {
                res.status(400).json({ message: 'Неверный формат email' });
                return;
            }
            
            const newUser = await UserService.createUser(userData);
            
            // Генерируем токен для нового пользователя
            const token = jwt.sign({ userId: newUser.id }, JWT_SECRET, { expiresIn: '7d' });
            
            res.status(201).json({ 
                user: {
                    id: newUser.id,
                    name: newUser.name,
                    email: newUser.email
                },
                token 
            });
        } catch (error: any) {
            console.error('Registration error:', error);
            
            // Обработка ошибки дубликата email
            if (error.message && error.message.includes('уже существует')) {
                res.status(409).json({ message: error.message });
                return;
            }
            
            // Обработка ошибки Sequelize unique constraint
            if (error.name === 'SequelizeUniqueConstraintError') {
                res.status(409).json({ message: 'Пользователь с таким email уже существует. Используйте другой email или войдите в существующий аккаунт.' });
                return;
            }
            
            res.status(500).json({ message: 'Ошибка при регистрации пользователя', error: error.message || 'Неизвестная ошибка' });
        }
    }

    async login(req: Request, res: Response): Promise<Response | void> {
        try {
            const credentials: LoginUserDTO = req.body;
            const token = await UserService.loginUser(credentials);

            if (!token) {
                return res.status(401).json({ message: 'Invalid email or password' });
            }

            return res.status(200).json({ token });
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }

    async getProfile(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const user = await UserService.getUserById(userId);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }
            return res.status(200).json(user);
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }

    async getInterests(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const interests = await UserService.getInterests(userId);
            // Явно маппим чтобы убедиться что isActive включен
            const mappedInterests = interests.map(interest => ({
                id: interest.id,
                interest: interest.interest,
                isActive: interest.isActive !== undefined ? interest.isActive : true, // По умолчанию true для старых записей
                lastUsedAt: interest.lastUsedAt,
                createdAt: interest.createdAt,
                updatedAt: interest.updatedAt
            }));
            return res.status(200).json(mappedInterests);
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }

    async updateInterests(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const { interests } = req.body;
            if (!Array.isArray(interests)) {
                return res.status(400).json({ message: 'Interests must be an array of strings or objects with {interest, level}' });
            }
            const updatedInterests = await UserService.updateInterests(userId, interests);
            return res.status(200).json(updatedInterests);
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }
    
    /**
     * Добавляет один интерес с опциональным уровнем
     * POST /api/auth/interests/add
     * Body: { interest: "танцы", level?: "novice" }
     */
    async addInterest(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const { interest, level } = req.body;
            if (!interest || typeof interest !== 'string') {
                return res.status(400).json({ message: 'Interest is required and must be a string' });
            }
            
            const validLevels = ['novice', 'amateur', 'professional'];
            if (level && !validLevels.includes(level)) {
                return res.status(400).json({ message: `Level must be one of: ${validLevels.join(', ')}` });
            }
            
            const result = await UserService.addInterest(userId, interest, level);
            return res.status(200).json({
                interest: result.interest,
                level: result.level || null,
            });
        } catch (error: any) {
            return res.status(500).json({ message: 'Server error', error: error.message });
        }
    }

    async getActiveInterests(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const activeInterests = await UserService.getActiveInterests(userId);
            return res.status(200).json(activeInterests);
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }

    async setActiveInterests(req: AuthenticatedRequest, res: Response): Promise<Response | void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                return res.status(401).json({ message: 'Unauthorized' });
            }
            const { interestIds } = req.body;
            if (!Array.isArray(interestIds)) {
                return res.status(400).json({ message: 'interestIds must be an array of numbers' });
            }
            await UserService.setActiveInterests(userId, interestIds);
            return res.status(200).json({ message: 'Active interests updated' });
        } catch (error) {
            return res.status(500).json({ message: 'Server error', error });
        }
    }
}
export default new UserController();
