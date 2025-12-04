import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';

export type BotMode = 'guest' | 'linked';

interface BotProfileAttributes {
    id: number;
    telegram_id: string;
    telegram_username?: string | null;
    telegram_chat_id?: string | null;
    mode: BotMode;
    user_id?: number | null;
    guest_interests?: string | null;
    guest_active_interests?: string | null;
    guest_levels?: string | null; // JSON объект: {"танцы": "beginner", "программирование": "intermediate"}
}

interface BotProfileCreationAttributes extends Optional<BotProfileAttributes, 'id' | 'mode'> {}

class BotProfile extends Model<BotProfileAttributes, BotProfileCreationAttributes> implements BotProfileAttributes {
    public id!: number;
    public telegram_id!: string;
    public telegram_username?: string | null;
    public telegram_chat_id?: string | null;
    public mode!: BotMode;
    public user_id?: number | null;
    public guest_interests?: string | null;
    public guest_active_interests?: string | null;
    public guest_levels?: string | null;

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

BotProfile.init(
    {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        telegram_id: {
            type: DataTypes.STRING,
            allowNull: false,
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
        mode: {
            type: DataTypes.ENUM('guest', 'linked'),
            allowNull: false,
            defaultValue: 'guest',
        },
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: User,
                key: 'id',
            },
            onDelete: 'CASCADE',
        },
        guest_interests: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        guest_active_interests: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        guest_levels: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
    },
    {
        tableName: 'bot_profiles',
        sequelize,
    }
);

BotProfile.belongsTo(User, { foreignKey: 'user_id' });

export default BotProfile;

