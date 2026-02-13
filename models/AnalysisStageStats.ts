import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

interface AnalysisStageStatsAttributes {
    id: number;
    stageId: number; // ID этапа (0-7 для видео, 0-4 для текста)
    stageName: string; // Название этапа
    itemType: 'channel' | 'urls' | 'text'; // Тип контента
    durationMs: number; // Длительность этапа в миллисекундах
    createdAt: Date;
}

interface AnalysisStageStatsCreationAttributes extends Optional<AnalysisStageStatsAttributes, 'id' | 'createdAt'> {}

class AnalysisStageStats extends Model<AnalysisStageStatsAttributes, AnalysisStageStatsCreationAttributes> implements AnalysisStageStatsAttributes {
    public id!: number;
    public stageId!: number;
    public stageName!: string;
    public itemType!: 'channel' | 'urls' | 'text';
    public durationMs!: number;
    public readonly createdAt!: Date;
}

AnalysisStageStats.init(
    {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        stageId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        stageName: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        itemType: {
            type: DataTypes.ENUM('channel', 'urls', 'text'),
            allowNull: false,
        },
        durationMs: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
        },
    },
    {
        tableName: 'analysis_stage_stats',
        sequelize,
        timestamps: true,
        updatedAt: false, // Только createdAt
        indexes: [
            { fields: ['stageId', 'itemType'] },
            { fields: ['createdAt'] },
        ],
    }
);

export default AnalysisStageStats;
