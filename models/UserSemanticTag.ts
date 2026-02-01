import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';

interface UserSemanticTagAttributes {
    id: number;
    userId: number;
    tag: string; // Тема, 1-3 слова, например "нейронные сети"
    weight: number; // Важность тега (частота использования)
    lastUsedAt?: Date | null;
}

interface UserSemanticTagCreationAttributes extends Optional<UserSemanticTagAttributes, 'id' | 'weight'> {}

class UserSemanticTag extends Model<UserSemanticTagAttributes, UserSemanticTagCreationAttributes> implements UserSemanticTagAttributes {
    public id!: number;
    public userId!: number;
    public tag!: string;
    public weight!: number;
    public lastUsedAt?: Date | null;

    public readonly createdAt!: Date;
    public readonly updatedAt!: Date;
}

UserSemanticTag.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
    },
    userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: User,
            key: 'id',
        },
        field: 'user_id',
    },
    tag: {
        type: DataTypes.STRING(255),
        allowNull: false,
    },
    weight: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 1.0,
        comment: 'Важность тега (частота использования)',
    },
    lastUsedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
        field: 'last_used',
    },
}, {
    tableName: 'user_semantic_tags',
    sequelize,
    timestamps: true,
    indexes: [
        { fields: ['user_id'] },
        { fields: ['tag'] },
        { fields: ['user_id', 'tag'], unique: true }, // Уникальность тега для пользователя
    ],
});

User.hasMany(UserSemanticTag, { foreignKey: 'userId' });
UserSemanticTag.belongsTo(User, { foreignKey: 'userId' });

export default UserSemanticTag;
