import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';
import AnalysisHistory from './AnalysisHistory';

interface UserAttributes {
    id: number;
    name: string;
    email: string;
    password_hash: string;
    interests?: string;
    telegram_id?: string | null;
    telegram_username?: string | null;
    telegram_chat_id?: string | null;
    telegram_link_code?: string | null;
    telegram_link_code_expires_at?: Date | null;
    password_reset_token?: string | null;
    password_reset_expires_at?: Date | null;
}

interface UserCreationAttributes extends Optional<UserAttributes, 'id'> {}

class User extends Model<UserAttributes, UserCreationAttributes> implements UserAttributes {
    public id!: number;
    public name!: string;
    public email!: string;
    public password_hash!: string;
    public interests?: string;
    public telegram_id?: string | null;
    public telegram_username?: string | null;
    public telegram_chat_id?: string | null;
    public telegram_link_code?: string | null;
    public telegram_link_code_expires_at?: Date | null;
    public password_reset_token?: string | null;
    public password_reset_expires_at?: Date | null;

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

User.init(
    {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        name: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        email: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true,
            validate: {
                isEmail: true,
            },
        },
        password_hash: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        interests: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        telegram_id: {
            type: DataTypes.STRING,
            allowNull: true,
            unique: true,
        },
        telegram_username: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        telegram_chat_id: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        telegram_link_code: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        telegram_link_code_expires_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        password_reset_token: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        password_reset_expires_at: {
            type: DataTypes.DATE,
            allowNull: true,
        },
    },
    {
        tableName: 'users',
        sequelize,
        timestamps: true,
    }
);

export default User;
