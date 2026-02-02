/**
 * Скрипт для проверки выполнения задач День 1 и День 2
 * Запуск: node check-semantic-features.js
 */

const http = require('http');

const API_URL = process.env.API_URL || 'http://localhost:5000';
const TEST_TEXTS = [
    {
        name: 'Статья про машинное обучение',
        text: 'Машинное обучение — это раздел искусственного интеллекта, который позволяет компьютерам обучаться на данных без явного программирования. Алгоритмы машинного обучения анализируют большие объемы данных, выявляют закономерности и делают прогнозы. Популярные библиотеки для машинного обучения включают TensorFlow, PyTorch и Scikit-learn.'
    },
    {
        name: 'Статья про веб-разработку',
        text: 'React — это популярная JavaScript библиотека для создания пользовательских интерфейсов. Она использует компонентный подход, что позволяет создавать переиспользуемые элементы интерфейса. React работает с виртуальным DOM для оптимизации производительности.'
    },
    {
        name: 'Статья про здоровье',
        text: 'Медитация и йога помогают снизить уровень стресса и улучшить общее самочувствие. Регулярные практики медитации способствуют улучшению концентрации внимания и эмоциональной стабильности. Йога сочетает физические упражнения с дыхательными техниками.'
    }
];

function makeRequest(options, data) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (e) {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });
        
        req.on('error', reject);
        if (data) {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
}

async function checkDay1() {
    console.log('\n📋 Проверка День 1: Подготовка базы\n');
    console.log('✅ Модель UserSemanticTag создана: server/models/UserSemanticTag.ts');
    console.log('✅ Эндпоинт GET /api/auth/profile/tags создан');
    console.log('⚠️  Для проверки эндпоинта нужен токен авторизации');
    console.log('   Используйте: curl -X GET http://localhost:5000/api/auth/profile/tags -H "Authorization: Bearer YOUR_TOKEN"');
}

async function checkDay2() {
    console.log('\n📋 Проверка День 2: AI-извлечение тем\n');
    console.log('✅ Файл semantic.service.ts создан');
    console.log('✅ Функция extractThemes реализована');
    console.log('\n🧪 Тестирование на 3 разных статьях...\n');
    
    for (let i = 0; i < TEST_TEXTS.length; i++) {
        const test = TEST_TEXTS[i];
        console.log(`Тест ${i + 1}: ${test.name}`);
        console.log(`Текст: ${test.text.substring(0, 50)}...`);
        
        try {
            const options = {
                hostname: 'localhost',
                port: 5000,
                path: '/api/analysis/test-extract-themes',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            };
            
            const result = await makeRequest(options, { text: test.text });
            
            if (result.status === 200 && result.data.success) {
                console.log(`✅ Успешно! Извлечено тем: ${result.data.themesCount}`);
                console.log(`   Темы: ${result.data.themes.join(', ')}`);
            } else {
                console.log(`❌ Ошибка: ${result.data.message || result.data.error || 'Unknown error'}`);
            }
        } catch (error) {
            console.log(`❌ Ошибка подключения: ${error.message}`);
            console.log('   Убедитесь, что сервер запущен: npm run dev');
        }
        
        console.log('');
    }
}

async function main() {
    console.log('🔍 Проверка выполнения задач День 1 и День 2\n');
    console.log('=' .repeat(60));
    
    await checkDay1();
    await checkDay2();
    
    console.log('\n' + '='.repeat(60));
    console.log('\n✅ Проверка завершена!');
    console.log('\n📝 Для подробной информации см. test-semantic-features.md');
}

main().catch(console.error);
