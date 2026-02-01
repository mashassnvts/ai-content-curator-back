/**
 * Скрипт для перегенерации всех эмбеддингов в базе данных
 * Используется для обновления формата эмбеддингов после изменения логики сохранения
 * 
 * Запуск: npx ts-node scripts/regenerate-embeddings.ts
 */

import dotenv from 'dotenv';
import sequelize from '../config/database';
import { QueryTypes } from 'sequelize';
import { generateEmbedding, saveEmbedding } from '../services/embedding.service';
import AnalysisHistory from '../models/AnalysisHistory';

dotenv.config();

async function regenerateEmbeddings() {
    try {
        console.log('🔄 Starting embedding regeneration...');
        
        // Получаем все записи с эмбеддингами
        const records = await sequelize.query(`
            SELECT id, url, summary, "userId"
            FROM analysis_history
            WHERE embedding IS NOT NULL
            AND summary IS NOT NULL
            AND summary != ''
            ORDER BY id DESC
        `, {
            type: QueryTypes.SELECT
        }) as Array<{
            id: number;
            url: string;
            summary: string;
            userId: number;
        }>;

        console.log(`📊 Found ${records.length} records with embeddings to regenerate`);

        let successCount = 0;
        let errorCount = 0;
        let skippedCount = 0;

        for (const record of records) {
            try {
                // Проверяем, что summary достаточно длинный
                if (!record.summary || record.summary.length < 50) {
                    console.log(`⏭️ Skipping record ${record.id}: summary too short (${record.summary?.length || 0} chars)`);
                    skippedCount++;
                    continue;
                }

                // Генерируем новый эмбеддинг используя только summary + URL
                // Это соответствует новому формату сохранения
                const textForEmbedding = [
                    record.summary,
                    record.url
                ].filter(Boolean).join('\n\n').trim();

                console.log(`🔄 Regenerating embedding for record ${record.id} (${textForEmbedding.length} chars)...`);

                // Генерируем новый эмбеддинг
                const embedding = await generateEmbedding(textForEmbedding);

                // Сохраняем новый эмбеддинг
                await saveEmbedding(record.id, embedding);

                successCount++;
                console.log(`✅ Successfully regenerated embedding for record ${record.id}`);

                // Небольшая задержка между запросами, чтобы не перегружать API
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (error: any) {
                errorCount++;
                console.error(`❌ Error regenerating embedding for record ${record.id}: ${error.message}`);
                // Продолжаем обработку остальных записей
            }
        }

        console.log('\n📊 Regeneration summary:');
        console.log(`   ✅ Successfully regenerated: ${successCount}`);
        console.log(`   ❌ Errors: ${errorCount}`);
        console.log(`   ⏭️ Skipped: ${skippedCount}`);
        console.log(`   📝 Total processed: ${records.length}`);

    } catch (error: any) {
        console.error(`❌ Fatal error: ${error.message}`);
        throw error;
    } finally {
        await sequelize.close();
    }
}

// Запускаем скрипт
regenerateEmbeddings()
    .then(() => {
        console.log('✅ Embedding regeneration completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Embedding regeneration failed:', error);
        process.exit(1);
    });
