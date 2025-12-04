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
            const newUser = await UserService.createUser(userData);
            res.status(201).json(newUser);
        } catch (error) {
            res.status(500).json({ message: 'Error registering new user', error });
        }
    }

    async login(req: Request, res: Response): Promise<void> {
        try {
            const credentials: LoginUserDTO = req.body;
            const token = await UserService.loginUser(credentials);

            if (!token) {
                res.status(401).json({ message: 'Invalid email or password' });
                return;
            }

            res.status(200).json({ token });
        } catch (error) {
            res.status(500).json({ message: 'Server error', error });
        }
    }

    async getProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }
            const user = await UserService.getUserById(userId);
            if (!user) {
                res.status(404).json({ message: 'User not found' });
                return;
            }
            res.status(200).json(user);
        } catch (error) {
            res.status(500).json({ message: 'Server error', error });
        }
    }

    async getInterests(req: AuthenticatedRequest, res: Response): Promise<void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }
            const interests = await UserService.getInterests(userId);
            res.status(200).json(interests);
        } catch (error) {
            res.status(500).json({ message: 'Server error', error });
        }
    }

    async updateInterests(req: AuthenticatedRequest, res: Response): Promise<void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }
            const { interests } = req.body;
            if (!Array.isArray(interests)) {
                res.status(400).json({ message: 'Interests must be an array of strings or objects with {interest, level}' });
                return;
            }
            const updatedInterests = await UserService.updateInterests(userId, interests);
            res.status(200).json(updatedInterests);
        } catch (error) {
            res.status(500).json({ message: 'Server error', error });
        }
    }
    
    /**
     * Добавляет один интерес с опциональным уровнем
     * POST /api/auth/interests/add
     * Body: { interest: "танцы", level?: "novice" }
     */
    async addInterest(req: AuthenticatedRequest, res: Response): Promise<void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }
            const { interest, level } = req.body;
            if (!interest || typeof interest !== 'string') {
                res.status(400).json({ message: 'Interest is required and must be a string' });
                return;
            }
            
            const validLevels = ['novice', 'amateur', 'professional'];
            if (level && !validLevels.includes(level)) {
                res.status(400).json({ message: `Level must be one of: ${validLevels.join(', ')}` });
                return;
            }
            
            const result = await UserService.addInterest(userId, interest, level);
            res.status(200).json({
                interest: result.interest,
                level: result.level || null,
            });
        } catch (error: any) {
            res.status(500).json({ message: 'Server error', error: error.message });
        }
    }

    async getActiveInterests(req: AuthenticatedRequest, res: Response): Promise<void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }
            const activeInterests = await UserService.getActiveInterests(userId);
            res.status(200).json(activeInterests);
        } catch (error) {
            res.status(500).json({ message: 'Server error', error });
        }
    }

    async setActiveInterests(req: AuthenticatedRequest, res: Response): Promise<void> {
        try {
            const userId = req.user?.userId;
            if (!userId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }
            const { interestIds } = req.body;
            if (!Array.isArray(interestIds)) {
                res.status(400).json({ message: 'interestIds must be an array of numbers' });
                return;
            }
            await UserService.setActiveInterests(userId, interestIds);
            res.status(200).json({ message: 'Active interests updated' });
        } catch (error) {
            res.status(500).json({ message: 'Server error', error });
        }
    }
}
export default new UserController();
