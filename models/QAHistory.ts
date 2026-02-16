import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';
import AnalysisHistory from './AnalysisHistory';

interface QAHistoryAttributes {
    id: number;
    analysisHistoryId: number | null;
    url: string; // URL или text:// для связи с анализом
    question: string;
    answer: string;
    userId: number | null;
    createdAt: Date;
}

interface QAHistoryCreationAttributes extends Optional<QAHistoryAttributes, 'id' | 'createdAt'> {}

class QAHistory extends Model<QAHistoryAttributes, QAHistoryCreationAttributes> implements QAHistoryAttributes {
    public id!: number;
    public analysisHistoryId!: number | null;
    public url!: string;
    public question!: string;
    public answer!: string;
    public userId!: number | null;
    public readonly createdAt!: Date;
}

QAHistory.init(
    {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        analysisHistoryId: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: AnalysisHistory,
                key: 'id',
            },
            field: 'analysis_history_id',
        },
        url: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        question: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        answer: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        userId: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: {
                model: User,
                key: 'id',
            },
            field: 'user_id',
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
            field: 'created_at',
        },
    },
    {
        tableName: 'qa_history',
        sequelize,
        timestamps: true,
        updatedAt: false,
        underscored: true,
        indexes: [
            { fields: ['analysis_history_id'] },
            { fields: ['url'] },
            { fields: ['user_id'] },
            { fields: ['created_at'] },
        ],
    }
);

User.hasMany(QAHistory, { foreignKey: 'userId' });
QAHistory.belongsTo(User, { foreignKey: 'userId' });
AnalysisHistory.hasMany(QAHistory, { foreignKey: 'analysisHistoryId' });
QAHistory.belongsTo(AnalysisHistory, { foreignKey: 'analysisHistoryId' });

export default QAHistory;
