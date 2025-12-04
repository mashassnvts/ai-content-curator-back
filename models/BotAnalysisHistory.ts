import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';
import BotProfile from './BotProfile';

interface BotAnalysisHistoryAttributes {
    id: number;
    telegram_id: string;
    url: string;
    interests: string;
    sourceType?: string | null;
    score?: number | null;
    verdict?: string | null;
    summary?: string | null;
    reasoning?: string | null;
    user_id?: number | null;
}

interface BotAnalysisHistoryCreationAttributes extends Optional<BotAnalysisHistoryAttributes, 'id' | 'sourceType' | 'score' | 'verdict' | 'summary' | 'reasoning' | 'user_id'> {}

class BotAnalysisHistory extends Model<BotAnalysisHistoryAttributes, BotAnalysisHistoryCreationAttributes> implements BotAnalysisHistoryAttributes {
    public id!: number;
    public telegram_id!: string;
    public url!: string;
    public interests!: string;
    public sourceType?: string | null;
    public score?: number | null;
    public verdict?: string | null;
    public summary?: string | null;
    public reasoning?: string | null;
    public user_id?: number | null;

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

BotAnalysisHistory.init(
    {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        telegram_id: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        url: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        interests: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        sourceType: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        score: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        verdict: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        summary: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        reasoning: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
    },
    {
        tableName: 'bot_analysis_history',
        sequelize,
        timestamps: true,
        indexes: [
            { fields: ['telegram_id'] },
            { fields: ['user_id'] },
            { fields: ['createdAt'] },
        ],
    }
);

BotProfile.hasMany(BotAnalysisHistory, { foreignKey: 'telegram_id', sourceKey: 'telegram_id' });
BotAnalysisHistory.belongsTo(BotProfile, { foreignKey: 'telegram_id', targetKey: 'telegram_id' });

export default BotAnalysisHistory;

