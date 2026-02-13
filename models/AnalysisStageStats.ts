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
            field: 'stage_id', // Маппинг на snake_case колонку в БД
        },
        stageName: {
            type: DataTypes.STRING,
            allowNull: false,
            field: 'stage_name', // Маппинг на snake_case колонку в БД
        },
        itemType: {
            type: DataTypes.ENUM('channel', 'urls', 'text'),
            allowNull: false,
            field: 'item_type', // Маппинг на snake_case колонку в БД
        },
        durationMs: {
            type: DataTypes.INTEGER,
            allowNull: false,
            field: 'duration_ms', // Маппинг на snake_case колонку в БД
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
            field: 'created_at', // Маппинг на snake_case колонку в БД
        },
    },
    {
        tableName: 'analysis_stage_stats',
        sequelize,
        timestamps: true,
        updatedAt: false, // Только createdAt
        underscored: true, // Использовать snake_case для автоматического маппинга
        indexes: [
            { fields: ['stage_id', 'item_type'] }, // Используем snake_case для индексов
            { fields: ['created_at'] },
        ],
    }
);

export default AnalysisStageStats;
