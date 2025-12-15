import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';

interface AnalysisHistoryAttributes {
    id: number;
    userId: number | null;
    telegramId: string | null;
    url: string;
    interests: string;
    sourceType: string;
    score: number;
    verdict: string;
    summary: string;
    reasoning: string;
}

interface AnalysisHistoryCreationAttributes extends Optional<AnalysisHistoryAttributes, 'id'> {}

class AnalysisHistory extends Model<AnalysisHistoryAttributes, AnalysisHistoryCreationAttributes> implements AnalysisHistoryAttributes {
    public id!: number;
    public userId!: number | null;
    public telegramId!: string | null;
    public url!: string;
    public interests!: string;
    public sourceType!: string;
    public score!: number;
    public verdict!: string;
    public summary!: string;
    public reasoning!: string;

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

AnalysisHistory.init(
    {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        userId: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: User,
                key: 'id',
            },
        },
        telegramId: {
            type: DataTypes.STRING,
            allowNull: true,
            field: 'telegram_id',
        },
        url: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        interests: {
            type: DataTypes.TEXT,
            allowNull: true,
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
    },
    {
        tableName: 'analysis_history',
        sequelize,
        timestamps: true,
        indexes: [
            { fields: ['userId'] },
            // Временно убрали индекс - Sequelize создаст его после добавления колонки через SQL
            // { fields: ['telegramId'] },
            { fields: ['createdAt'] },
        ],
    }
);

User.hasMany(AnalysisHistory, { foreignKey: 'userId' });
AnalysisHistory.belongsTo(User, { foreignKey: 'userId' });

export default AnalysisHistory;
