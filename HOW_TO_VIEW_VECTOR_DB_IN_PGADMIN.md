# Как посмотреть таблицы векторной БД в pgAdmin

## 📋 Пошаговая инструкция

### 1. Открыть pgAdmin

1. Запустите **pgAdmin** (обычно в меню Пуск или на рабочем столе)
2. В левой панели найдите ваш сервер PostgreSQL
3. Разверните дерево: **Servers** → **Ваш сервер** → **Databases**

### 2. Подключиться к базе данных

1. Найдите вашу базу данных (обычно называется `content_curator` или как указано в `.env`)
2. Разверните базу данных: **Databases** → **content_curator** → **Schemas** → **public**

### 3. Посмотреть таблицы

1. Разверните **Tables**
2. Найдите таблицу **`analysis_history`** — это основная таблица с векторными данными

### 4. Проверить структуру таблицы

**Способ 1: Через интерфейс**
1. Правый клик на таблице **`analysis_history`**
2. Выберите **View/Edit Data** → **All Rows** (или **First 100 Rows**)

**Способ 2: Через SQL**
1. Правый клик на базе данных → **Query Tool**
2. Выполните запрос:

```sql
-- Посмотреть структуру таблицы
SELECT 
    column_name, 
    data_type, 
    character_maximum_length
FROM information_schema.columns
WHERE table_name = 'analysis_history'
ORDER BY ordinal_position;
```

### 5. Посмотреть векторные данные

**Важно:** Поле `embedding` имеет тип `vector(768)` — это массив из 768 чисел.

**Проверка наличия эмбеддингов:**

```sql
-- Сколько записей с эмбеддингами
SELECT 
    COUNT(*) as total_records,
    COUNT(embedding) as records_with_embedding,
    COUNT(*) - COUNT(embedding) as records_without_embedding
FROM analysis_history;
```

**Посмотреть записи с эмбеддингами:**

```sql
-- Посмотреть записи с эмбеддингами (первые 10)
SELECT 
    id,
    url,
    CASE 
        WHEN embedding IS NOT NULL THEN 'Есть' 
        ELSE 'Нет' 
    END as has_embedding,
    summary,
    score,
    verdict,
    "createdAt"
FROM analysis_history
WHERE embedding IS NOT NULL
ORDER BY id DESC
LIMIT 10;
```

**Посмотреть сам вектор (первые несколько измерений):**

```sql
-- Посмотреть первые 10 измерений вектора (для проверки)
SELECT 
    id,
    url,
    -- Извлекаем первые 10 измерений вектора для просмотра
    (embedding::text::vector)[1:10] as embedding_preview
FROM analysis_history
WHERE embedding IS NOT NULL
ORDER BY id DESC
LIMIT 5;
```

### 6. Проверить установку pgvector

```sql
-- Проверить, установлено ли расширение vector
SELECT * FROM pg_extension WHERE extname = 'vector';

-- Если расширение не установлено, установите его:
-- CREATE EXTENSION IF NOT EXISTS vector;
```

**Проверить версию pgvector:**

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

### 7. Проверить индекс для векторного поиска

```sql
-- Посмотреть индексы на таблице analysis_history
SELECT 
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'analysis_history';

-- Должен быть индекс типа ivfflat для поля embedding
```

### 8. Посмотреть процент схожести между статьями

#### Вариант 1: Найти похожие статьи для конкретной статьи

```sql
-- Замените 123 на ID статьи, для которой хотите найти похожие
-- Этот запрос покажет все похожие статьи с процентом схожести

WITH target_article AS (
    SELECT 
        id,
        url,
        summary,
        embedding
    FROM analysis_history
    WHERE id = 123 AND embedding IS NOT NULL
)
SELECT 
    ah.id,
    ah.url,
    LEFT(ah.summary, 150) as summary_preview,
    ta.url as target_url,
    LEFT(ta.summary, 100) as target_summary,
    -- Вычисляем схожесть (cosine similarity) в процентах
    ROUND((1 - (ah.embedding <=> ta.embedding))::numeric, 2) * 100 as similarity_percent,
    -- Также показываем расстояние (чем меньше, тем больше схожесть)
    ROUND((ah.embedding <=> ta.embedding)::numeric, 4) as distance
FROM analysis_history ah
CROSS JOIN target_article ta
WHERE ah.embedding IS NOT NULL
  AND ah.id != ta.id
  AND (1 - (ah.embedding <=> ta.embedding)) >= 0.50  -- Порог 50% (можно изменить)
ORDER BY ah.embedding <=> ta.embedding ASC  -- Сортируем по схожести (от большей к меньшей)
LIMIT 10;
```

#### Вариант 2: Посмотреть схожесть всех статей с последней проанализированной

```sql
-- Находит похожие статьи для последней проанализированной статьи

WITH latest_article AS (
    SELECT 
        id,
        url,
        summary,
        embedding
    FROM analysis_history
    WHERE embedding IS NOT NULL
    ORDER BY "createdAt" DESC
    LIMIT 1
)
SELECT 
    ah.id,
    ah.url,
    LEFT(ah.summary, 150) as summary_preview,
    la.url as latest_article_url,
    -- Процент схожести
    ROUND((1 - (ah.embedding <=> la.embedding))::numeric, 2) * 100 as similarity_percent,
    ah.score,
    ah.verdict,
    ah."createdAt"
FROM analysis_history ah
CROSS JOIN latest_article la
WHERE ah.embedding IS NOT NULL
  AND ah.id != la.id
ORDER BY ah.embedding <=> la.embedding ASC
LIMIT 10;
```

#### Вариант 3: Создать представление (VIEW) для удобного просмотра схожести

```sql
-- Создает представление, которое можно использовать для быстрого просмотра
-- ВАЖНО: Это может быть медленно для больших таблиц!

CREATE OR REPLACE VIEW article_similarity_view AS
SELECT 
    a1.id as article1_id,
    a1.url as article1_url,
    LEFT(a1.summary, 100) as article1_summary,
    a2.id as article2_id,
    a2.url as article2_url,
    LEFT(a2.summary, 100) as article2_summary,
    -- Процент схожести
    ROUND((1 - (a1.embedding <=> a2.embedding))::numeric, 2) * 100 as similarity_percent,
    -- Расстояние
    ROUND((a1.embedding <=> a2.embedding)::numeric, 4) as distance
FROM analysis_history a1
CROSS JOIN analysis_history a2
WHERE a1.embedding IS NOT NULL
  AND a2.embedding IS NOT NULL
  AND a1.id < a2.id  -- Избегаем дубликатов (a1->a2 и a2->a1)
  AND (1 - (a1.embedding <=> a2.embedding)) >= 0.50;  -- Только похожие статьи (>=50%)

-- Теперь можно использовать представление:
SELECT * FROM article_similarity_view
ORDER BY similarity_percent DESC
LIMIT 20;
```

#### Вариант 4: Посмотреть схожесть конкретной статьи со всеми остальными (с процентами)

```sql
-- Замените URL на URL статьи, для которой хотите найти похожие
-- Показывает все статьи с процентом схожести

WITH target AS (
    SELECT id, url, summary, embedding
    FROM analysis_history
    WHERE url = 'https://www.nur.kz/family/beauty/1615450-kak-nayti-svoy-stil-v-odezhde-muzhchine/'
      AND embedding IS NOT NULL
    LIMIT 1
)
SELECT 
    ah.id,
    ah.url,
    LEFT(ah.summary, 200) as summary,
    -- Процент схожести (0-100%)
    ROUND((1 - (ah.embedding <=> t.embedding))::numeric, 2) * 100 as similarity_percent,
    -- Визуальная индикация схожести
    CASE 
        WHEN (1 - (ah.embedding <=> t.embedding)) >= 0.80 THEN '🟢 Очень похоже (80%+)'
        WHEN (1 - (ah.embedding <=> t.embedding)) >= 0.70 THEN '🟡 Похоже (70-79%)'
        WHEN (1 - (ah.embedding <=> t.embedding)) >= 0.60 THEN '🟠 Умеренно похоже (60-69%)'
        WHEN (1 - (ah.embedding <=> t.embedding)) >= 0.50 THEN '🔴 Слабо похоже (50-59%)'
        ELSE '⚪ Не похоже (<50%)'
    END as similarity_level,
    ah.score,
    ah.verdict,
    ah."createdAt"
FROM analysis_history ah
CROSS JOIN target t
WHERE ah.embedding IS NOT NULL
  AND ah.id != t.id
ORDER BY ah.embedding <=> t.embedding ASC  -- От самых похожих к менее похожим
LIMIT 20;
```

#### Вариант 5: Статистика схожести для всех статей (топ самых похожих пар)

```sql
-- Показывает топ-20 самых похожих пар статей

SELECT 
    a1.id as article1_id,
    a1.url as article1_url,
    LEFT(a1.summary, 80) as article1_summary,
    a2.id as article2_id,
    a2.url as article2_url,
    LEFT(a2.summary, 80) as article2_summary,
    -- Процент схожести
    ROUND((1 - (a1.embedding <=> a2.embedding))::numeric, 2) * 100 as similarity_percent,
    -- Расстояние между векторами
    ROUND((a1.embedding <=> a2.embedding)::numeric, 4) as distance
FROM analysis_history a1
CROSS JOIN analysis_history a2
WHERE a1.embedding IS NOT NULL
  AND a2.embedding IS NOT NULL
  AND a1.id < a2.id  -- Избегаем дубликатов
ORDER BY a1.embedding <=> a2.embedding ASC  -- От самых похожих
LIMIT 20;
```

## 🔍 Полезные запросы для диагностики

### Статистика по эмбеддингам

```sql
-- Общая статистика
SELECT 
    COUNT(*) as total_articles,
    COUNT(embedding) as articles_with_embedding,
    ROUND(COUNT(embedding)::numeric / COUNT(*)::numeric * 100, 2) as embedding_coverage_percent
FROM analysis_history;
```

### Последние проанализированные статьи

```sql
-- Последние 10 статей с эмбеддингами
SELECT 
    id,
    url,
    score,
    verdict,
    LEFT(summary, 100) as summary_preview,
    "createdAt"
FROM analysis_history
WHERE embedding IS NOT NULL
ORDER BY "createdAt" DESC
LIMIT 10;
```

### Статьи без эмбеддингов (нужно обработать)

```sql
-- Статьи, для которых не был сгенерирован эмбеддинг
SELECT 
    id,
    url,
    "createdAt"
FROM analysis_history
WHERE embedding IS NULL
ORDER BY "createdAt" DESC;
```

## ⚠️ Важные замечания

1. **Вектор нельзя просмотреть полностью** — это массив из 768 чисел, он занимает много места. Используйте `[1:10]` для просмотра первых измерений.

2. **Тип данных `vector`** — это специальный тип pgvector, не обычный массив PostgreSQL.

3. **Индекс `ivfflat`** — используется для быстрого векторного поиска. Если его нет, поиск будет медленным.

4. **Размерность вектора** — в вашем проекте используется 768 измерений (обрезается с 3072 от Gemini).

## 🎯 Быстрый старт

1. Откройте pgAdmin
2. Подключитесь к базе данных
3. Выполните в Query Tool:

```sql
-- Быстрая проверка
SELECT 
    COUNT(*) as total,
    COUNT(embedding) as with_embedding,
    COUNT(*) - COUNT(embedding) as without_embedding
FROM analysis_history;
```

Если `with_embedding > 0` — векторная БД работает! ✅

## 📊 Просмотр процента схожести между статьями

### Самый простой способ — найти похожие для конкретной статьи:

```sql
-- Замените 123 на ID статьи из вашей БД
-- Покажет все похожие статьи с процентом схожести

WITH target AS (
    SELECT id, url, embedding
    FROM analysis_history
    WHERE id = 123 AND embedding IS NOT NULL
)
SELECT 
    ah.id,
    ah.url,
    LEFT(ah.summary, 150) as summary,
    -- Процент схожести (0-100%)
    ROUND((1 - (ah.embedding <=> t.embedding))::numeric, 2) * 100 as similarity_percent,
    ah.score,
    ah."createdAt"
FROM analysis_history ah
CROSS JOIN target t
WHERE ah.embedding IS NOT NULL
  AND ah.id != t.id
ORDER BY similarity_percent DESC  -- От самых похожих
LIMIT 10;
```

### Или по URL статьи:

```sql
-- Замените URL на URL вашей статьи
WITH target AS (
    SELECT id, url, embedding
    FROM analysis_history
    WHERE url LIKE '%nur.kz%stil%'  -- Или точный URL
      AND embedding IS NOT NULL
    LIMIT 1
)
SELECT 
    ah.id,
    ah.url,
    LEFT(ah.summary, 150) as summary,
    ROUND((1 - (ah.embedding <=> t.embedding))::numeric, 2) * 100 as similarity_percent
FROM analysis_history ah
CROSS JOIN target t
WHERE ah.embedding IS NOT NULL
  AND ah.id != t.id
ORDER BY similarity_percent DESC
LIMIT 10;
```

**Результат будет выглядеть так:**
```
id  | url                    | summary              | similarity_percent
----|------------------------|----------------------|------------------
45  | https://habr.com/...   | Статья про стиль...  | 85.23
67  | https://example.com/...| Статья про моду...   | 72.15
...
```
