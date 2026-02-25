import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';
import { ExtractedContent } from '../models/content.model';
import play from 'play-dl';
// @ts-ignore - fs-extra types may not be available
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

// Stealth/Adblocker can cause "Requesting main frame too early!" in Docker/Railway; disable via env
if (!process.env.DISABLE_PUPPETEER_STEALTH) {
    puppeteer.use(StealthPlugin());
    puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
}

class ContentService {
    /**
     * Нормализует транскрипт видео: удаляет временные метки, лишние пробелы, специальные символы
     */
    private normalizeTranscript(transcript: string): string {
        if (!transcript || transcript.trim().length === 0) {
            return '';
        }
        
        return transcript
            // Удаляем временные метки в форматах [00:00], (00:00), 00:00:00, 00:00
            .replace(/\[?\d{1,2}:\d{2}(?::\d{2})?\]?/g, '')
            .replace(/\(?\d{1,2}:\d{2}(?::\d{2})?\)?/g, '')
            // Удаляем специальные символы (›, », «)
            .replace(/[›»«]/g, '')
            // Удаляем множественные пробелы
            .replace(/\s+/g, ' ')
            // Нормализуем переносы строк (убираем множественные)
            .replace(/\n{3,}/g, '\n\n')
            // Убираем пробелы в начале и конце строк
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .join(' ')
            .trim();
    }

    async extractContentFromUrl(url: string): Promise<ExtractedContent> {
        // Проверяем, является ли это Telegram постом
        const telegramPostMatch = url.match(/^https?:\/\/t\.me\/([^\/]+)\/(\d+)$/);
        if (telegramPostMatch) {
            return await this.extractTelegramPostContent(url);
        }
        
        // Проверяем, является ли это постом или страницей Twitter/X (в т.ч. x.com/i/trending/...)
        const twitterStatusMatch = url.match(/^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/);
        const twitterTrendingMatch = url.match(/^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/i\/trending\/\d+/);
        if (twitterStatusMatch || twitterTrendingMatch) {
            return await this.extractTwitterPostContent(url);
        }
        
        // Ссылка на профиль Twitter/X (без /status/) — контент не извлекаем, бросаем сразу (regex, не зависит от URL parsing)
        const twitterProfileMatch = (url || '').trim().match(/^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)(?:\/|$|\?|#)/i);
        if (twitterProfileMatch) {
            const username = twitterProfileMatch[1];
            if (username && username.toLowerCase() !== 'i') {
                console.log(`🐦 [Twitter/X] Profile URL detected in extractContentFromUrl, throwing TWITTER_PROFILE_URL: @${username}`);
                throw new Error('TWITTER_PROFILE_URL');
            }
        }
        
        // Определяем тип URL
        const videoPlatform = this.detectVideoPlatform(url);
        
        if (videoPlatform) {
            console.log(`Processing ${videoPlatform} video: ${url}`);
            
            // ============================================
            // ПРИОРИТЕТ 1: ПОЛУЧЕНИЕ ТРАНСКРИПТА ВИДЕО
            // ============================================
            // Для всех видео сначала пытаемся получить полную расшифровку (транскрипт)
            // Только если ВСЕ методы получения транскрипта провалились, используем метаданные
            
            if (videoPlatform === 'youtube') {
                console.log('🎬 [YouTube] Attempting to extract video transcript (full content)...');
                console.log('   ⚠️ IMPORTANT: Will try ALL transcript methods before falling back to metadata');
                
                // Метод 1: Puppeteer (открывает браузер и извлекает транскрипт со страницы) - ПРИОРИТЕТНЫЙ
                try {
                    console.log('   [1/4] Trying Puppeteer (browser-based) for transcript...');
                    // Увеличиваем таймаут до 90 секунд для Puppeteer (больше времени на загрузку и клики)
                    const transcriptText = await Promise.race([
                        this.getYouTubeTranscript(url),
                        new Promise<string>((_, reject) => 
                            setTimeout(() => reject(new Error('Transcript extraction timeout')), 120000) // Увеличено до 120 секунд
                        )
                    ]);
                    
                    if (transcriptText && transcriptText.trim().length > 30) {
                        const normalized = this.normalizeTranscript(transcriptText);
                        if (normalized.length > 30) {
                            console.log(`✓✓✓ SUCCESS: Using YouTube transcript (Puppeteer) (${normalized.length} chars)`);
                            return { content: normalized, sourceType: 'transcript' };
                        } else {
                            console.log(`   ⚠️ Puppeteer transcript too short after normalization (${normalized.length} chars)`);
                        }
                    } else {
                        console.log(`   ⚠️ Puppeteer returned empty or too short transcript (${transcriptText?.length || 0} chars)`);
                    }
                } catch (puppeteerError: any) {
                    const errorMsg = puppeteerError.message || 'Unknown error';
                    // Не логируем таймаут как критическую ошибку, просто продолжаем
                    if (errorMsg.includes('timeout')) {
                        console.log(`   ⚠️ Puppeteer timeout (90s) - trying next method...`);
                    } else {
                        console.log(`   ⚠️ Puppeteer failed: ${errorMsg.substring(0, 100)}`);
                    }
                }
                
                // Метод 2: Библиотека youtube-transcript (быстрый, не требует браузер)
                try {
                    console.log('   [2/4] Trying youtube-transcript library...');
                    const { YoutubeTranscript } = await import('youtube-transcript');
                    
                    // Пробуем сначала без указания языка (автоматический выбор)
                    try {
                        const transcriptItems = await YoutubeTranscript.fetchTranscript(url);
                        const transcriptText = transcriptItems.map(item => item.text).join(' ');
                        
                        if (transcriptText && transcriptText.trim().length > 30) {
                            const normalized = this.normalizeTranscript(transcriptText);
                            if (normalized.length > 30) {
                                console.log(`✓✓✓ SUCCESS: Using youtube-transcript library (${normalized.length} chars)`);
                                return { content: normalized, sourceType: 'transcript' };
                            }
                        }
                    } catch (autoError: any) {
                        // Если автоматический выбор не сработал, пробуем с конкретными языками
                        const languages = ['ru', 'en', 'uk'];
                        for (const lang of languages) {
                            try {
                                console.log(`   Trying youtube-transcript with language: ${lang}...`);
                                const transcriptItems = await YoutubeTranscript.fetchTranscript(url, { lang });
                                const transcriptText = transcriptItems.map(item => item.text).join(' ');
                                
                                if (transcriptText && transcriptText.trim().length > 30) {
                                    const normalized = this.normalizeTranscript(transcriptText);
                                    if (normalized.length > 30) {
                                        console.log(`✓✓✓ SUCCESS: Using youtube-transcript library (${lang}, ${normalized.length} chars)`);
                                        return { content: normalized, sourceType: 'transcript' };
                                    }
                                }
                            } catch (langError: any) {
                                // Пробуем следующий язык
                                continue;
                            }
                        }
                        throw autoError; // Если все языки провалились, пробрасываем исходную ошибку
                    }
                } catch (youtubeTranscriptError: any) {
                    const errorMsg = youtubeTranscriptError.message || 'Unknown error';
                    if (errorMsg.includes('captcha') || errorMsg.includes('too many requests')) {
                        console.log(`   ⚠️ youtube-transcript failed: YouTube requires captcha or rate limited`);
                    } else {
                        console.log(`   ⚠️ youtube-transcript failed: ${errorMsg}`);
                    }
                }
                
                // Метод 3: ScrapingBee API для получения HTML и извлечения транскрипта
                try {
                    console.log('   [3/4] Trying ScrapingBee API for transcript...');
                    const scrapingBeeContent = await this.extractWithScrapingBee(url);
                    if (scrapingBeeContent) {
                        console.log(`   ✓ ScrapingBee returned HTML (${scrapingBeeContent.length} chars)`);
                        const transcriptText = await this.extractTranscriptFromHTML(scrapingBeeContent, url);
                        if (transcriptText && transcriptText.trim().length > 30) {
                            const normalized = this.normalizeTranscript(transcriptText);
                            if (normalized.length > 30) {
                                console.log(`✓✓✓ SUCCESS: Using ScrapingBee for YouTube transcript (${normalized.length} chars)`);
                                return { content: normalized, sourceType: 'transcript' };
                            }
                        }
                    }
                } catch (scrapingBeeError: any) {
                    console.log(`   ⚠️ ScrapingBee failed: ${scrapingBeeError.message}`);
                }
                
                // Метод 4: yt-dlp для извлечения субтитров (если доступны)
                try {
                    console.log('   [4/4] Trying yt-dlp for transcript extraction...');
                    const transcriptText = await this.extractTranscriptWithYtDlp(url);
                    if (transcriptText && transcriptText.trim().length > 30) {
                        const normalized = this.normalizeTranscript(transcriptText);
                        if (normalized.length > 30) {
                            console.log(`✓✓✓ SUCCESS: Using yt-dlp transcript (${normalized.length} chars)`);
                            return { content: normalized, sourceType: 'transcript' };
                        } else {
                            console.log(`   ⚠️ yt-dlp transcript too short after normalization (${normalized.length} chars)`);
                        }
                    } else {
                        console.log(`   ⚠️ yt-dlp returned empty or too short transcript (${transcriptText?.length || 0} chars)`);
                    }
                } catch (ytDlpError: any) {
                    const errorMsg = ytDlpError.message || 'Unknown error';
                    // Если это блокировка бота, не логируем как ошибку
                    if (errorMsg.includes('Sign in to confirm') || errorMsg.includes('not a bot')) {
                        console.log(`   ⚠️ yt-dlp blocked by YouTube (bot detection) - this is expected, trying other methods...`);
                    } else {
                        console.log(`   ⚠️ yt-dlp transcript extraction failed: ${errorMsg.substring(0, 100)}`);
                    }
                }
                
                // Все методы получения транскрипта провалились
                console.log('⚠️⚠️⚠️ ALL TRANSCRIPT METHODS FAILED ⚠️⚠️⚠️');
                console.log('❌ All transcript extraction methods failed for YouTube.');
                console.log('   → This video may not have transcripts available, or all methods were blocked.');
                console.log('   → Proceeding to metadata fallback (title + description only)...');
            }

            // Для не-YouTube платформ: попытка автоматической транскрибации
            // Транскрипция включена по умолчанию, отключается только если DISABLE_VIDEO_TRANSCRIPTION=true
            const disableTranscription = process.env.DISABLE_VIDEO_TRANSCRIPTION === 'true';

            if (!disableTranscription && videoPlatform !== 'youtube') {
                console.log(`🎬 [${videoPlatform}] Attempting automatic transcription to get full video content...`);
                try {
                    const transcribedText = await this.transcribeVideo(url, videoPlatform);
                    if (transcribedText && transcribedText.trim().length > 30) {
                        const normalized = this.normalizeTranscript(transcribedText);
                        if (normalized.length > 30) {
                            console.log(`✓✓✓ SUCCESS: Using automatic transcription (${normalized.length} chars) - full video content extracted`);
                            return { content: normalized, sourceType: 'transcript' };
                        }
                    } else {
                        console.warn(`⚠️ Transcription returned empty or too short text (${transcribedText?.length || 0} chars)`);
                    }
                } catch (error: any) {
                    const errorMsg = error.message || 'Unknown error';
                    console.warn(`⚠️ Automatic transcription failed for ${videoPlatform}: ${errorMsg}`);
                    if (errorMsg.includes('download') || errorMsg.includes('Failed to download')) {
                        console.warn(`   → Video download failed. May be private or unsupported.`);
                    } else if (errorMsg.includes('extract') || errorMsg.includes('audio')) {
                        console.warn(`   → Audio extraction failed.`);
                    } else if (errorMsg.includes('Transcription failed') || errorMsg.includes('Whisper')) {
                        console.warn(`   → Transcription service failed.`);
                    }
                }
            } else if (disableTranscription && videoPlatform !== 'youtube') {
                console.log(`⏭️ Video transcription disabled. Using metadata only.`);
            }

            // ============================================
            // ПРИОРИТЕТ 2: МЕТАДАННЫЕ (только если транскрипт недоступен)
            // ============================================
            console.log(`📋 [${videoPlatform}] Transcript unavailable. Falling back to metadata extraction...`);


            // 3. ПРИОРИТЕТНЫЙ FALLBACK: Метаданные через yt-dlp (самый быстрый и надежный способ получить название/описание)
            try {
                const ytDlpMetadata = await this.fetchMetadataWithYtDlp(url);
                if (ytDlpMetadata && ytDlpMetadata.content && ytDlpMetadata.content.trim().length > 100) {
                    console.log(`✓ Using yt-dlp metadata for ${videoPlatform} (transcription unavailable)`);
                    return ytDlpMetadata;
                }
            } catch (error: any) {
                console.warn(`⚠️ yt-dlp metadata extraction failed for ${videoPlatform}: ${error.message}`);
                console.log(`Falling back to Puppeteer extraction...`);
            }

            // 4. FALLBACK: Метаданные через ScrapingBee (не требует браузеров)
            try {
                const scrapingBeeContent = await this.extractWithScrapingBee(url);
                if (scrapingBeeContent) {
                    const cheerio = await import('cheerio');
                    const $ = cheerio.load(scrapingBeeContent);
                    
                    // Извлекаем метаданные (title, description)
                    const title = $('meta[property="og:title"]').attr('content') || 
                                 $('title').text() || 
                                 $('h1').first().text();
                    const description = $('meta[property="og:description"]').attr('content') || 
                                      $('meta[name="description"]').attr('content') || '';
                    
                    if (title || description) {
                        const contentParts: string[] = [];
                        if (title) contentParts.push(`Название: ${title.trim()}`);
                        if (description) contentParts.push(`\n\nОписание: ${description.trim()}`);
                        
                        const content = contentParts.join('') + 
                            '\n\n⚠️ ВАЖНО: Это только метаданные видео (название, описание). Полная расшифровка видео недоступна. Анализ проводится ТОЛЬКО на основе этих метаданных.';
                        
                        console.log(`✓ Using ScrapingBee metadata for ${videoPlatform}`);
                        return { content, sourceType: 'metadata' };
                    }
                }
            } catch (scrapingBeeError: any) {
                console.log(`⚠️ ScrapingBee metadata extraction failed: ${scrapingBeeError.message}`);
            }
            
            // 5. FALLBACK 2: Парсинг страницы через Puppeteer (более медленный, но позволяет собрать доп. текст и комментарии)
            // Используем Promise.race с коротким таймаутом, чтобы не ждать слишком долго
            try {
                const metadataPromise = this.extractVideoMetadata(url, videoPlatform);
                const timeoutPromise = new Promise<null>((resolve) => 
                    setTimeout(() => resolve(null), 25000) // Таймаут 25 секунд
                );
                
                const metadata = await Promise.race([metadataPromise, timeoutPromise]);
                if (metadata && metadata.content && metadata.content.trim().length > 100) {
                    console.log(`✓ Using Puppeteer metadata for ${videoPlatform} (includes page content)`);
                    return metadata;
                } else if (metadata === null) {
                    console.warn(`⚠️ Metadata extraction (puppeteer) timed out for ${videoPlatform}, trying basic metadata...`);
                }
            } catch (error: any) {
                const errorMsg = error.message || '';
                if (errorMsg.includes('timeout') || errorMsg.includes('Navigation timeout')) {
                    console.warn(`⚠️ Metadata extraction (puppeteer) timed out for ${videoPlatform}, trying basic metadata...`);
                } else {
                    console.warn(`⚠️ Metadata extraction (puppeteer) failed for ${videoPlatform}: ${errorMsg}`);
                }
            }

            // 6. ПОСЛЕДНИЙ FALLBACK: play-dl (только для YouTube, если все остальное провалилось)
            if (videoPlatform === 'youtube') {
                try {
                    const videoInfo = await play.video_info(url);
                    const { title, description } = videoInfo.video_details;
                    const content = `Название: ${title || 'Нет названия'}\n\nОписание: ${description || 'Нет описания'}\n\n⚠️ ВАЖНО: Это только метаданные видео. Полная расшифровка недоступна. Анализ проводится ТОЛЬКО на основе этих метаданных.`;
                    console.log('⚠️ Using play-dl metadata (transcript unavailable)');
                    return { content, sourceType: 'metadata' };
                } catch (error: any) {
                    console.error(`✗ play-dl metadata extraction failed: ${error.message}`);
                }
            }
            
            // 7. ФИНАЛЬНЫЙ FALLBACK: Извлечение базовых метаданных через простой HTTP-запрос
            // Это гарантирует, что мы всегда получим хотя бы название и описание из og:tags
            try {
                console.log(`🔄 Attempting final fallback: extracting basic metadata from page...`);
                const basicMetadata = await this.extractBasicMetadata(url);
                if (basicMetadata && basicMetadata.content && basicMetadata.content.trim().length > 50) {
                    console.log(`✓ Using basic metadata as last resort`);
                    return basicMetadata;
                }
            } catch (error: any) {
                console.warn(`⚠️ Basic metadata extraction failed: ${error.message}`);
            }
            
            // Если даже базовые метаданные не получены, возвращаем минимальную информацию вместо ошибки
            console.warn(`⚠️ All content extraction methods failed for ${videoPlatform}. Returning minimal metadata.`);
            return {
                content: `⚠️ ВАЖНО: Не удалось извлечь полный контент из видео. Браузер недоступен на этом сервере, или видео требует аутентификации. Анализ будет проведен только на основе URL и доступных метаданных.\n\nURL: ${url}\nПлатформа: ${videoPlatform}`,
                sourceType: 'metadata' as const
            };
        } else {
            // Повторная проверка: ссылка на профиль X/Twitter не должна парситься как статья
            try {
                const parsed = new URL(url.trim().split('?')[0].split('#')[0] || url);
                const host = parsed.hostname.toLowerCase();
                const pathname = parsed.pathname.replace(/\/+$/, '').replace(/^\/+/, '');
                const isTwitterHost = host === 'twitter.com' || host === 'x.com' || host.endsWith('.twitter.com') || host.endsWith('.x.com');
                const isProfilePath = /^[a-zA-Z0-9_]+$/.test(pathname) && !pathname.toLowerCase().startsWith('i');
                if (isTwitterHost && isProfilePath) {
                    throw new Error('TWITTER_PROFILE_URL');
                }
            } catch (e: any) {
                if (e?.message === 'TWITTER_PROFILE_URL') throw e;
            }
            // ... (Статья - сначала пробуем ScrapingBee, потом Puppeteer)
            // Сначала пробуем ScrapingBee (не требует браузеров)
            try {
                const scrapingBeeContent = await this.extractWithScrapingBee(url);
                if (scrapingBeeContent) {
                    const cheerio = await import('cheerio');
                    const $ = cheerio.load(scrapingBeeContent);
                    
                    // Извлекаем основной контент статьи
                    const mainContentSelectors = ['article', 'main', '.post-content', '.article-body', 'body'];
                    let mainEl = null;
                    for (const selector of mainContentSelectors) {
                        const element = $(selector).first();
                        if (element.length > 0) {
                            mainEl = element;
                            break;
        }
    }

                    if (mainEl && mainEl.length > 0) {
                        // Удаляем ненужные элементы
                        mainEl.find('script, style, nav, header, footer, aside, form, button, .comments, #comments').remove();
                        
                        // Извлекаем текст
                        const paragraphs = mainEl.find('p, h1, h2, h3, li, pre, code').toArray();
                        const content = paragraphs
                            .map((el: any) => $(el).text().trim())
                            .filter((text: string) => text.length > 20)
                            .join('\n\n');
                        
                        if (content.trim().length > 100) {
                            console.log(`✓ Using ScrapingBee for article (${content.length} chars)`);
                            return { content, sourceType: 'article' };
                        }
                    }
                }
            } catch (scrapingBeeError: any) {
                console.log(`⚠️ ScrapingBee failed for article: ${scrapingBeeError.message}`);
                console.log(`   Trying Puppeteer fallback...`);
            }
            
            // Fallback на Puppeteer (ещё раз не парсить профиль X)
            try {
                const parsed2 = new URL(url.trim().split('?')[0].split('#')[0] || url);
                const host2 = parsed2.hostname.toLowerCase();
                const path2 = parsed2.pathname.replace(/\/+$/, '').replace(/^\/+/, '');
                if ((host2 === 'twitter.com' || host2 === 'x.com') && /^[a-zA-Z0-9_]+$/.test(path2) && !path2.toLowerCase().startsWith('i')) {
                    throw new Error('TWITTER_PROFILE_URL');
                }
                return await this.scrapeArticleWithPuppeteer(url);
            } catch (puppeteerError: any) {
                if (puppeteerError?.message === 'TWITTER_PROFILE_URL') throw puppeteerError;
                const errorMsg = puppeteerError.message || 'Unknown error';
                console.warn(`⚠️ Puppeteer scraping failed: ${errorMsg}`);
                
                // Проверяем, является ли ошибка связанной с отсутствием Chrome
                if (errorMsg.includes('Could not find Chrome') || 
                    errorMsg.includes('Chrome not found') || 
                    errorMsg.includes('Chrome/Chromium not available') ||
                    !process.env.PUPPETEER_EXECUTABLE_PATH) {
                    // Пробуем извлечь базовые метаданные через HTTP запрос (без браузера)
                    try {
                        console.log('Attempting to extract basic metadata without browser...');
                        const response = await fetch(url, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                            }
                        });
                        const html = await response.text();
                        
                        // Извлекаем og:tags и title из HTML
                        const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
                        const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
                        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
                        
                        const title = ogTitleMatch?.[1] || titleMatch?.[1] || '';
                        const description = ogDescMatch?.[1] || '';
                        
                        if (title || description) {
                            const contentParts: string[] = [];
                            if (title) contentParts.push(`Название: ${title}`);
                            if (description) contentParts.push(`\n\nОписание: ${description}`);
                            
                            const content = contentParts.join('') + 
                                '\n\n⚠️ ВАЖНО: Это только базовые метаданные страницы. Полный контент статьи недоступен без браузера.';
                            
                            console.log(`✓ Extracted basic metadata without browser (title: ${title ? 'yes' : 'no'}, desc: ${description ? 'yes' : 'no'})`);
                            return { content, sourceType: 'metadata' };
                        }
                    } catch (fetchError: any) {
                        console.warn(`⚠️ Basic metadata extraction failed: ${fetchError.message}`);
                    }
                }
                
                // ФИНАЛЬНЫЙ FALLBACK: Пытаемся извлечь хотя бы базовые метаданные
                try {
                    console.log(`🔄 Attempting final fallback: extracting basic metadata from article...`);
                    const basicMetadata = await this.extractBasicMetadata(url);
                    if (basicMetadata && basicMetadata.content && basicMetadata.content.trim().length > 20) {
                        console.log(`✓ Using basic metadata as last resort for article`);
                        return basicMetadata;
                    }
                } catch (metadataError: any) {
                    console.warn(`⚠️ Final metadata fallback failed: ${metadataError.message}`);
                }
                
                // Если даже базовые метаданные не получены, возвращаем минимальную информацию вместо ошибки
                console.warn(`⚠️ All content extraction methods failed. Returning minimal metadata.`);
                return {
                    content: `⚠️ ВАЖНО: Не удалось извлечь полный контент из статьи. Браузер недоступен на этом сервере. Анализ будет проведен только на основе URL и доступных метаданных.\n\nURL: ${url}`,
                    sourceType: 'metadata' as const
                };
            }
        }
    }

    /**
     * Вспомогательная функция для получения настроек запуска Puppeteer с автоматическим поиском Chrome
     */
    private async getPuppeteerLaunchOptions(additionalArgs: string[] = []): Promise<any> {
            const launchOptions: any = {
                headless: true,
                // Railway/Docker: Chrome и тяжёлые страницы (X.com) — CDP (Runtime.callFunctionOn и др.) может таймаутить
                protocolTimeout: 600000, // 10 минут — для контейнеров и медленного evaluate() на X.com
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--lang=ru-RU,ru',
                    '--disable-features=TranslateUI',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                ...additionalArgs
                ]
            };
        
            // Используем системный Chromium, если указан путь
            if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            console.log('Using system Chrome/Chromium from PUPPETEER_EXECUTABLE_PATH');
            return launchOptions;
        }
        
        // Пытаемся найти Chrome в стандартных местах или использовать встроенный
        const possiblePaths = [
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
        ];
        
        let foundPath = null;
        const fsModule = await import('fs');
        
        // Сначала проверяем стандартные пути
        for (const path of possiblePaths) {
            try {
                if (fsModule.existsSync(path)) {
                    foundPath = path;
                    break;
                }
            } catch (e) {
                // Игнорируем ошибки проверки
            }
        }
        
        // Если не нашли, пытаемся использовать Chrome, установленный через Puppeteer
        if (!foundPath) {
            try {
                // Используем @puppeteer/browsers для поиска установленного Chrome
                const { detectBrowserPlatform, getInstalledBrowsers, computeExecutablePath, Browser } = await import('@puppeteer/browsers');
                const cacheDir = process.env.PUPPETEER_CACHE_DIR || 
                                (process.env.HOME ? `${process.env.HOME}/.cache/puppeteer` : null) ||
                                '/opt/render/.cache/puppeteer' ||
                                os.homedir() + '/.cache/puppeteer';
                
                try {
                    // Определяем платформу и ищем установленные браузеры
                    const platform = detectBrowserPlatform();
                    if (platform) {
                        const installedBrowsers = await getInstalledBrowsers({
                            cacheDir: cacheDir
                        });
                        
                        // Ищем Chrome среди установленных браузеров
                        const chromeBrowser = installedBrowsers.find((b: any) => b.browser === Browser.CHROME);
                        if (chromeBrowser) {
                            const chromePath = computeExecutablePath({
                                browser: Browser.CHROME,
                                cacheDir: cacheDir,
                                buildId: chromeBrowser.buildId,
                                platform: platform
                            });
                            
                            if (chromePath && fsModule.existsSync(chromePath)) {
                                foundPath = chromePath;
                                console.log(`✓ Found Puppeteer-installed Chrome via @puppeteer/browsers at: ${foundPath}`);
                            }
                        }
                    }
                } catch (computeError) {
                    // Если новый API не сработал, пробуем старый способ
                    const puppeteerModule = await import('puppeteer');
                    // @ts-ignore - executablePath может быть доступен через внутренний API
                    const puppeteerPath = (puppeteerModule as any).executablePath?.() || 
                                         (puppeteerModule as any).default?.executablePath?.();
                    if (puppeteerPath && fsModule.existsSync(puppeteerPath)) {
                        foundPath = puppeteerPath;
                        console.log(`✓ Found Puppeteer-installed Chrome at: ${foundPath}`);
                    }
                }
            } catch (e) {
                console.log(`⚠️ Could not get Chrome path from Puppeteer: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
        }
        
        // Проверяем путь к кэшу Puppeteer (для Render.com и других платформ)
        if (!foundPath) {
            const possibleCachePaths = [
                process.env.PUPPETEER_CACHE_DIR,
                process.env.HOME ? `${process.env.HOME}/.cache/puppeteer` : null,
                '/opt/render/.cache/puppeteer',
                '/root/.cache/puppeteer',
                os.homedir() + '/.cache/puppeteer'
            ].filter(Boolean) as string[];
            
            for (const cachePath of possibleCachePaths) {
                try {
                    if (fsModule.existsSync(cachePath)) {
                        console.log(`🔍 Checking Puppeteer cache at: ${cachePath}`);
                        const entries = fsModule.readdirSync(cachePath);
                        console.log(`   Found ${entries.length} entries in cache`);
                        
                        // Ищем директории с Chrome
                        const chromeDirs = entries.filter((dir: string) => 
                            dir.startsWith('chrome') || dir.startsWith('chromium')
                        );
                        
                        console.log(`   Found ${chromeDirs.length} Chrome directories: ${chromeDirs.join(', ')}`);
                        
                        for (const dir of chromeDirs) {
                            // Пробуем разные возможные структуры
                            const possibleChromePaths = [
                                `${cachePath}/${dir}/chrome-linux64/chrome`,
                                `${cachePath}/${dir}/chrome-linux64/chromium`,
                                `${cachePath}/${dir}/chrome-linux/chrome`,
                                `${cachePath}/${dir}/chrome-linux/chromium`,
                                `${cachePath}/${dir}/chrome/chrome`,
                                `${cachePath}/${dir}/chrome/chromium`,
                                `${cachePath}/${dir}/chrome`,
                                `${cachePath}/${dir}/chromium`,
                                `${cachePath}/${dir}/headless_shell`,
                            ];
                            
                            // Также пробуем использовать @puppeteer/browsers для вычисления пути
                            try {
                                const { detectBrowserPlatform, getInstalledBrowsers, computeExecutablePath, Browser } = await import('@puppeteer/browsers');
                                const platform = detectBrowserPlatform();
                                if (platform) {
                                    const installedBrowsers = await getInstalledBrowsers({
                                        cacheDir: cachePath
                                    });
                                    const chromeBrowser = installedBrowsers.find((b: any) => b.browser === Browser.CHROME);
                                    if (chromeBrowser) {
                                        const computedPath = computeExecutablePath({
                                            browser: Browser.CHROME,
                                            cacheDir: cachePath,
                                            buildId: chromeBrowser.buildId,
                                            platform: platform
                                        });
                                        if (computedPath && fsModule.existsSync(computedPath)) {
                                            foundPath = computedPath;
                                            console.log(`✓ Found Chrome via computeExecutablePath at: ${foundPath}`);
                                            break;
                                        }
                                    }
                                }
                            } catch (e) {
                                // Игнорируем ошибки computeExecutablePath
                            }
                            
                            for (const chromePath of possibleChromePaths) {
                                if (fsModule.existsSync(chromePath)) {
                                    // Проверяем, что это исполняемый файл
                                    const stats = fsModule.statSync(chromePath);
                                    if (stats.isFile()) {
                                        foundPath = chromePath;
                                        console.log(`✓ Found Chrome in Puppeteer cache at: ${foundPath}`);
                                        break;
                                    }
                                }
                            }
                            if (foundPath) break;
                        }
                    }
                } catch (e) {
                    console.log(`⚠️ Error checking cache path ${cachePath}: ${e instanceof Error ? e.message : 'Unknown error'}`);
                }
                if (foundPath) break;
            }
        }
        
        if (foundPath) {
            launchOptions.executablePath = foundPath;
            console.log(`Using Chrome/Chromium at: ${foundPath}`);
        } else {
            console.log('PUPPETEER_EXECUTABLE_PATH not set and Chrome not found in standard paths.');
            console.log('Puppeteer will try to use bundled Chrome (if available).');
        }
        
        return launchOptions;
    }

    /**
     * Извлекает HTML контент через ScrapingBee API (не требует браузеров)
     */
    private async extractWithScrapingBee(url: string): Promise<string | null> {
        // Поддержка нескольких API ключей через переменную окружения (разделенные запятыми)
        const apiKeysEnv = process.env.SCRAPINGBEE_API_KEY || process.env.SCRAPINGBEE_API_KEYS;
        if (!apiKeysEnv) {
            console.log('⚠️ SCRAPINGBEE_API_KEY or SCRAPINGBEE_API_KEYS not set, skipping ScrapingBee');
            return null;
        }

        // Разбиваем ключи по запятым и очищаем от пробелов
        const apiKeys = apiKeysEnv.split(',').map(key => key.trim()).filter(key => key.length > 0);
        
        if (apiKeys.length === 0) {
            console.log('⚠️ No valid ScrapingBee API keys found');
            return null;
        }

        const axios = await import('axios');
        const apiUrl = 'https://app.scrapingbee.com/api/v1/';

        // Пробуем каждый ключ по очереди
        for (let i = 0; i < apiKeys.length; i++) {
            const apiKey = apiKeys[i];
            const isLastKey = i === apiKeys.length - 1;
            
            try {
                if (apiKeys.length > 1) {
                    console.log(`Trying ScrapingBee API (key ${i + 1}/${apiKeys.length})...`);
                } else {
                    console.log('Trying ScrapingBee API...');
                }
                
                const params = new URLSearchParams({
                    'api_key': apiKey,
                    'url': url,
                    'render_js': 'true', // Выполняет JavaScript на странице
                    'premium_proxy': 'true', // Использует премиум прокси для обхода блокировок
                    'country_code': 'us', // Страна прокси
                });

                const response = await axios.default.get(apiUrl, {
                    params: params,
                    timeout: 30000, // 30 секунд таймаут
                });

                if (response.data) {
                    console.log('✓ ScrapingBee successfully fetched content');
                    return typeof response.data === 'string' ? response.data : response.data.toString();
                }
            } catch (error: any) {
                const status = error.response?.status;
                const statusText = error.response?.statusText;
                
                // Обрабатываем разные типы ошибок
                if (status === 401 || status === 403) {
                    console.log(`⚠️ ScrapingBee API authentication error (${status}) for key ${i + 1}: Invalid API key or access denied`);
                    if (!isLastKey) {
                        console.log(`   Trying next API key...`);
                        continue; // Пробуем следующий ключ
                    }
                } else if (status === 429) {
                    console.log(`⚠️ ScrapingBee API rate limit exceeded (429) for key ${i + 1}: Too many requests`);
                    if (!isLastKey) {
                        console.log(`   Trying next API key...`);
                        continue; // Пробуем следующий ключ
                    }
                } else if (status >= 500) {
                    console.log(`⚠️ ScrapingBee API server error (${status}) for key ${i + 1}: ${statusText || error.message}`);
                    if (!isLastKey) {
                        console.log(`   Trying next API key...`);
                        continue; // Пробуем следующий ключ
                    }
                } else {
                    console.log(`⚠️ ScrapingBee API error for key ${i + 1}: ${error.message || 'Unknown error'}`);
                    if (!isLastKey) {
                        console.log(`   Trying next API key...`);
                        continue; // Пробуем следующий ключ
                    }
                }
            }
        }
        
        console.log(`❌ All ScrapingBee API keys failed`);
        return null;
    }

    /**
     * Извлекает транскрипт из HTML страницы YouTube
     */
    private async extractTranscriptFromHTML(html: string, url: string): Promise<string | null> {
        try {
            // Извлекаем video ID из URL
            const videoIdMatch = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/);
            const videoId = videoIdMatch ? videoIdMatch[1] : null;
            
            if (!videoId) {
                console.log('⚠️ Could not extract video ID from URL');
                return null;
            }

            console.log(`🔍 Searching for transcript in HTML for video: ${videoId}`);

            // Метод 1: Ищем транскрипт в JSON данных страницы (ytInitialPlayerResponse)
            const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
            console.log(`   Found ${scripts.length} script tags to search`);
            
            for (const scriptTag of scripts) {
                const scriptContent = scriptTag.replace(/<\/?script[^>]*>/gi, '');
                
                // Ищем ytInitialPlayerResponse
                if (scriptContent.includes('ytInitialPlayerResponse')) {
                    console.log('   Found ytInitialPlayerResponse, parsing...');
                    try {
                        // Пробуем разные паттерны для извлечения JSON
                        const patterns = [
                            /var ytInitialPlayerResponse\s*=\s*({[\s\S]+?});/,
                            /"ytInitialPlayerResponse"\s*:\s*({[\s\S]+?})(?=;|$)/,
                            /ytInitialPlayerResponse\s*=\s*({[\s\S]+?});/,
                            /ytInitialPlayerResponse\s*=\s*({[\s\S]+?})(?=;|<\/script>|$)/m
                        ];
                        
                        for (const pattern of patterns) {
                            const match = scriptContent.match(pattern);
                            if (match && match[1]) {
                                try {
                                    // Очищаем JSON от возможных лишних символов
                                    let jsonStr = match[1].trim();
                                    // Убираем завершающие точки с запятой или другие символы
                                    jsonStr = jsonStr.replace(/;[\s]*$/, '');
                                    // Убираем возможные завершающие скобки после JSON
                                    if (jsonStr.endsWith('})')) {
                                        jsonStr = jsonStr.slice(0, -1);
                                    }
                                    
                                    const data = JSON.parse(jsonStr);
                                    
                                    // Ищем captionTracks в разных местах структуры
                                    let captionTracks = null;
                                    const searchPaths = [
                                        () => data?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
                                        () => data?.captions?.playerCaptionsRenderer?.captionTracks,
                                        () => data?.videoDetails?.captionTracks,
                                        () => data?.captionTracks,
                                        () => data?.captions?.captionTracks,
                                        () => data?.playerCaptionsTracklistRenderer?.captionTracks
                                    ];
                                    
                                    for (const path of searchPaths) {
                                        captionTracks = path();
                                        if (captionTracks && Array.isArray(captionTracks) && captionTracks.length > 0) {
                                            break;
                                        }
                                    }
                                    
                                    if (captionTracks && Array.isArray(captionTracks) && captionTracks.length > 0) {
                                        console.log(`   Found ${captionTracks.length} caption tracks`);
                                        // Ищем русский или английский трек, или берем первый доступный
                                        let captionTrack = captionTracks.find((track: any) => 
                                            (track.languageCode === 'ru' || track.languageCode === 'en') && 
                                            (track.baseUrl || track.url)
                                        ) || captionTracks.find((track: any) => track.baseUrl || track.url);
                                        
                                        if (captionTrack) {
                                            let captionUrl = captionTrack.baseUrl || captionTrack.url;
                                            
                                            if (captionUrl) {
                                                // Декодируем Unicode escape sequences в URL
                                                try {
                                                    captionUrl = captionUrl.replace(/\\u([0-9a-fA-F]{4})/g, (match: string, hex: string) => {
                                                        return String.fromCharCode(parseInt(hex, 16));
                                                    });
                                                } catch (e) {
                                                    // Если декодирование не удалось, используем исходный URL
                                                }
                                                
                                                console.log(`✓ Found caption track: ${captionTrack.languageCode || 'unknown'}`);
                                                console.log(`   Attempting to download transcript from URL...`);
                                                const transcript = await this.downloadTranscriptFromUrl(captionUrl);
                                                if (transcript && transcript.trim().length > 30) {
                                                    const normalized = this.normalizeTranscript(transcript);
                                                    if (normalized.length > 30) {
                                                        console.log(`✓✓✓ SUCCESS: Downloaded transcript from caption track (${normalized.length} chars)`);
                                                        return normalized;
                                                    }
                                                } else {
                                                    console.log(`   ⚠️ Transcript download returned empty or too short (${transcript?.length || 0} chars)`);
                                                }
                                            }
                                        }
                                    }
                                } catch (parseError: any) {
                                    // Пробуем следующий паттерн или ищем другим способом
                                    if (!parseError.message.includes('Unexpected token') && !parseError.message.includes('JSON')) {
                                        console.log(`   JSON parse error: ${parseError.message.substring(0, 100)}`);
                                    }
                                    continue;
                                }
                            }
                        }
                        
                        // Альтернативный метод: ищем captionTracks напрямую в тексте через regex
                        if (scriptContent.includes('captionTracks')) {
                            console.log('   Trying alternative regex method for captionTracks...');
                            try {
                                // Более гибкий поиск baseUrl
                                const baseUrlPatterns = [
                                    /"baseUrl"\s*:\s*"([^"]+)"/,
                                    /baseUrl["\s]*:["\s]*"([^"]+)"/,
                                    /"url"\s*:\s*"([^"]+timedtext[^"]+)"/,
                                    /captionTracks[^[]*\[[^\]]*"baseUrl"[^"]*"([^"]+)"/,
                                ];
                                
                                    for (const pattern of baseUrlPatterns) {
                                        const matches = scriptContent.matchAll(new RegExp(pattern.source, 'g'));
                                        for (const match of matches) {
                                            if (match[1] && match[1].includes('timedtext')) {
                                                // Декодируем Unicode escape sequences в URL
                                                let decodedUrl = match[1];
                                                try {
                                                    decodedUrl = decodedUrl.replace(/\\u([0-9a-fA-F]{4})/g, (m: string, hex: string) => {
                                                        return String.fromCharCode(parseInt(hex, 16));
                                                    });
                                                } catch (e) {
                                                    // Если декодирование не удалось, используем исходный URL
                                                }
                                                
                            console.log(`✓ Found caption URL via regex: ${decodedUrl.substring(0, 100)}...`);
                            console.log(`   Attempting to download transcript from URL...`);
                            const transcript = await this.downloadTranscriptFromUrl(decodedUrl);
                            if (transcript && transcript.trim().length > 30) {
                                console.log(`✓✓✓ SUCCESS: Downloaded transcript via ScrapingBee (${transcript.length} chars)`);
                                return transcript;
                            } else {
                                console.log(`   ⚠️ Transcript download returned empty or too short (${transcript?.length || 0} chars)`);
                            }
                                            }
                                        }
                                    }
                            } catch (e) {
                                console.log(`   Regex method failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
                            }
                        }
                    } catch (e) {
                        console.log(`   Error processing script: ${e instanceof Error ? e.message : 'Unknown error'}`);
                        continue;
                    }
                }
            }
            
            // Метод 2: Прямой поиск URL транскрипта в HTML через regex
            console.log('   Trying direct URL search in HTML...');
            try {
                const directUrlPatterns = [
                    /"baseUrl"\s*:\s*"([^"]+timedtext[^"]+)"/g,
                    /baseUrl["\s]*:["\s]*"([^"]+timedtext[^"]+)"/g,
                    /captionTracks[^[]*\[[^\]]*"baseUrl"[^"]*"([^"]+timedtext[^"]+)"/g,
                ];
                
                for (const pattern of directUrlPatterns) {
                    const matches = html.matchAll(pattern);
                    for (const match of matches) {
                        if (match[1] && match[1].includes('timedtext')) {
                            // Декодируем Unicode escape sequences в URL
                            let decodedUrl = match[1];
                            try {
                                decodedUrl = decodedUrl.replace(/\\u([0-9a-fA-F]{4})/g, (m: string, hex: string) => {
                                    return String.fromCharCode(parseInt(hex, 16));
                                });
                            } catch (e) {
                                // Если декодирование не удалось, используем исходный URL
                            }
                            
                            console.log(`✓ Found transcript URL directly in HTML`);
                            console.log(`   Attempting to download transcript from URL...`);
                            const transcript = await this.downloadTranscriptFromUrl(decodedUrl);
                            if (transcript && transcript.trim().length > 30) {
                                console.log(`✓✓✓ SUCCESS: Downloaded transcript directly from HTML (${transcript.length} chars)`);
                                return transcript;
                            } else {
                                console.log(`   ⚠️ Transcript download returned empty or too short (${transcript?.length || 0} chars)`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.log(`   Direct URL search failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
            
            // Метод 3: Прямой запрос к YouTube API для получения транскрипта
            console.log('   Trying YouTube API method...');
            try {
                const transcriptUrl = await this.getYouTubeTranscriptUrl(videoId);
                if (transcriptUrl) {
                    console.log(`✓ Got transcript URL from API`);
                    console.log(`   Attempting to download transcript from URL...`);
                    const transcript = await this.downloadTranscriptFromUrl(transcriptUrl);
                    if (transcript && transcript.trim().length > 30) {
                        console.log(`✓✓✓ SUCCESS: Downloaded transcript via YouTube API (${transcript.length} chars)`);
                        return transcript;
                    } else {
                        console.log(`   ⚠️ Transcript download returned empty or too short (${transcript?.length || 0} chars)`);
                    }
                }
            } catch (e) {
                console.log(`   YouTube API method failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
            
            console.log('❌ No transcript found in HTML');
            return null;
        } catch (error: any) {
            console.log(`⚠️ Failed to extract transcript from HTML: ${error.message}`);
            return null;
        }
    }

    /**
     * Загружает транскрипт по URL
     */
    private async downloadTranscriptFromUrl(captionUrl: string): Promise<string | null> {
        try {
            // Декодируем Unicode escape sequences в URL (например, \u0026 -> &)
            let decodedUrl = captionUrl;
            try {
                // Заменяем Unicode escape sequences
                decodedUrl = decodedUrl.replace(/\\u([0-9a-fA-F]{4})/g, (match: string, hex: string) => {
                    return String.fromCharCode(parseInt(hex, 16));
                });
                // Также декодируем стандартные escape sequences
                decodedUrl = decodeURIComponent(decodedUrl);
            } catch (decodeError) {
                // Если декодирование не удалось, используем исходный URL
                console.log(`   Warning: Could not decode URL, using original`);
            }
            
            console.log(`   📥 Downloading transcript from: ${decodedUrl.substring(0, 150)}...`);
            
            const axios = await import('axios');
            const transcriptResponse = await axios.default.get(decodedUrl, {
                timeout: 15000, // Увеличено с 10 до 15 секунд
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/xml,application/xml,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
                    'Referer': 'https://www.youtube.com/' // Добавляем Referer для YouTube
                },
                maxRedirects: 5,
                validateStatus: (status) => status < 500 // Принимаем все статусы кроме 5xx
            });
            
            const status = transcriptResponse.status;
            if (status !== 200) {
                console.log(`   ⚠️ Transcript URL returned status ${status}: ${decodedUrl.substring(0, 100)}...`);
                return null;
            }
            
            const transcriptXml = transcriptResponse.data;
            
            // Проверяем, что получили XML
            if (typeof transcriptXml !== 'string' || !transcriptXml.includes('<text')) {
                console.log(`   ⚠️ Transcript response is not valid XML (length: ${transcriptXml?.length || 0})`);
                // Возможно это HTML страница с ошибкой, пробуем найти текст в HTML
                if (typeof transcriptXml === 'string' && transcriptXml.includes('<html')) {
                    console.log(`   → Got HTML instead of XML, transcript may be unavailable`);
                }
                return null;
            }
            
            const transcriptItems: string[] = [];
            
            // Парсим XML транскрипта (YouTube использует формат timedtext)
            const textMatches = transcriptXml.matchAll(/<text[^>]*>([^<]+)<\/text>/g);
            for (const match of textMatches) {
                const text = match[1]
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .trim();
                if (text) {
                    transcriptItems.push(text);
                }
            }
            
            if (transcriptItems.length > 0) {
                const fullTranscript = transcriptItems.join(' ');
                const normalized = this.normalizeTranscript(fullTranscript);
                console.log(`✓ Successfully extracted ${transcriptItems.length} transcript items (${normalized.length} chars)`);
                return normalized;
            } else {
                console.log(`   ⚠️ No transcript items found in XML (XML length: ${transcriptXml.length})`);
                // Пробуем альтернативный формат парсинга
                const altMatches = transcriptXml.matchAll(/<text[^>]*start="[^"]*"[^>]*>([^<]+)<\/text>/g);
                for (const match of altMatches) {
                    const text = match[1]
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .trim();
                    if (text) {
                        transcriptItems.push(text);
                    }
                }
                if (transcriptItems.length > 0) {
                    const fullTranscript = transcriptItems.join(' ');
                    const normalized = this.normalizeTranscript(fullTranscript);
                    console.log(`✓ Successfully extracted ${transcriptItems.length} transcript items using alternative parsing (${normalized.length} chars)`);
                    return normalized;
                }
            }
            
            return null;
        } catch (error: any) {
            const status = error.response?.status;
            const errorMessage = error.message || 'Unknown error';
            
            if (status === 404) {
                console.log(`   ⚠️ Transcript URL returned 404 (may be expired or invalid): ${captionUrl.substring(0, 100)}...`);
            } else if (status === 403) {
                console.log(`   ⚠️ Transcript URL returned 403 (access forbidden): ${captionUrl.substring(0, 100)}...`);
            } else if (errorMessage.includes('timeout') || errorMessage.includes('ECONNABORTED')) {
                console.log(`   ⚠️ Transcript download timeout: ${errorMessage}`);
            } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
                console.log(`   ⚠️ DNS error when downloading transcript: ${errorMessage}`);
            } else {
                console.log(`   ⚠️ Failed to download transcript from URL (status: ${status || 'N/A'}): ${errorMessage.substring(0, 200)}`);
            }
            return null;
        }
    }

    /**
     * Получает URL транскрипта напрямую через YouTube API
     */
    private async getYouTubeTranscriptUrl(videoId: string): Promise<string | null> {
        try {
            const axios = await import('axios');
            
            // Пробуем получить страницу видео
            const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const response = await axios.default.get(videoUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                timeout: 15000,
                maxRedirects: 5
            });
            
            const html = response.data;
            const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
            
            // Ищем в скриптах с ytInitialPlayerResponse
            for (const scriptTag of scripts) {
                const scriptContent = scriptTag.replace(/<\/?script[^>]*>/gi, '');
                
                if (scriptContent.includes('ytInitialPlayerResponse')) {
                    try {
                        // Пробуем извлечь JSON
                        const patterns = [
                            /var ytInitialPlayerResponse\s*=\s*({[\s\S]+?});/,
                            /ytInitialPlayerResponse\s*=\s*({[\s\S]+?})(?=;|<\/script>|$)/m
                        ];
                        
                        for (const pattern of patterns) {
                            const match = scriptContent.match(pattern);
                            if (match && match[1]) {
                                try {
                                    let jsonStr = match[1].trim().replace(/;[\s]*$/, '');
                                    const data = JSON.parse(jsonStr);
                                    
                                    // Ищем captionTracks
                                    const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
                                                         data?.captions?.playerCaptionsRenderer?.captionTracks ||
                                                         data?.videoDetails?.captionTracks ||
                                                         data?.captionTracks;
                                    
                                    if (captionTracks && Array.isArray(captionTracks) && captionTracks.length > 0) {
                                        const track = captionTracks.find((t: any) => 
                                            (t.languageCode === 'ru' || t.languageCode === 'en') && (t.baseUrl || t.url)
                                        ) || captionTracks.find((t: any) => t.baseUrl || t.url);
                                        
                                        if (track?.baseUrl || track?.url) {
                                            let transcriptUrl = track.baseUrl || track.url;
                                            // Декодируем Unicode escape sequences
                                            try {
                                                transcriptUrl = transcriptUrl.replace(/\\u([0-9a-fA-F]{4})/g, (m: string, hex: string) => {
                                                    return String.fromCharCode(parseInt(hex, 16));
                                                });
                                            } catch (e) {
                                                // Если декодирование не удалось, используем исходный URL
                                            }
                                            return transcriptUrl;
                                        }
                                    }
                                } catch (e) {
                                    continue;
                                }
                            }
                        }
                    } catch (e) {
                        continue;
                    }
                }
                
                // Альтернативный поиск через regex
                if (scriptContent.includes('captionTracks')) {
                    const urlPatterns = [
                        /"baseUrl"\s*:\s*"([^"]+timedtext[^"]+)"/,
                        /baseUrl["\s]*:["\s]*"([^"]+timedtext[^"]+)"/,
                    ];
                    
                    for (const pattern of urlPatterns) {
                        const match = scriptContent.match(pattern);
                        if (match && match[1] && match[1].includes('timedtext')) {
                            let transcriptUrl = match[1];
                            // Декодируем Unicode escape sequences
                            try {
                                transcriptUrl = transcriptUrl.replace(/\\u([0-9a-fA-F]{4})/g, (m: string, hex: string) => {
                                    return String.fromCharCode(parseInt(hex, 16));
                                });
                            } catch (e) {
                                // Если декодирование не удалось, используем исходный URL
                            }
                            return transcriptUrl;
                        }
                    }
                }
            }
            
            return null;
        } catch (error: any) {
            console.log(`⚠️ Failed to get transcript URL: ${error.message}`);
            return null;
        }
    }

    private async getYouTubeTranscript(url: string): Promise<string> {
        let browser = null;
        try {
            console.log('Launching browser to extract YouTube transcript...');
            
            const launchOptions = await this.getPuppeteerLaunchOptions();
            
            // Добавляем таймаут на запуск браузера (90 сек для Railway/Docker — Chrome может грузиться долго)
            browser = await Promise.race([
                puppeteer.launch(launchOptions),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Browser launch timeout')), 90000)
                )
            ]) as any;
    
            const page = await browser.newPage();
            
            // Устанавливаем пользовательский агент и язык
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
            });
    
            console.log(`Navigating to YouTube video: ${url}`);
            await page.goto(url, { 
                waitUntil: 'domcontentloaded', // Изменено с networkidle2 на domcontentloaded для быстрой загрузки
                timeout: 120000 // Увеличено до 120 секунд для медленных соединений
            });

            // Ждем полной загрузки страницы (увеличено время ожидания для надежности)
            console.log('   Waiting for page to fully load...');
            await new Promise(resolve => setTimeout(resolve, 10000)); // Увеличено до 10 секунд для полной загрузки

            // Прокручиваем немного вниз чтобы загрузить все элементы
            await page.evaluate(() => {
                window.scrollBy(0, 300);
            });
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Стратегия 1: Прямой поиск кнопки "Расшифровка" или "Show transcript" в правой панели
            try {
                // Ищем кнопку транскрипта в правой панели (под видео)
                const transcriptButtonSelectors = [
                    'button[aria-label*="Show transcript"]',
                    'button[aria-label*="Показать расшифровку"]',
                    'button[aria-label*="Show transcript"]',
                    'ytd-menu-renderer button[aria-label*="transcript"]',
                    '#actions button[aria-label*="transcript"]',
                    'ytd-menu-renderer button[aria-label*="расшифровка"]',
                    'button[title*="Show transcript"]',
                    'button[title*="Показать расшифровку"]',
                    '#button[aria-label*="transcript" i]', // case-insensitive
                    'yt-icon-button[aria-label*="transcript" i]'
                ];

                for (const selector of transcriptButtonSelectors) {
                    try {
                        // Ждем появления кнопки с увеличенным таймаутом
                        await page.waitForSelector(selector, { timeout: 10000 }).catch(() => null);
                        const button = await page.$(selector);
                        if (button) {
                            await button.click();
                            console.log(`✓ Clicked transcript button: ${selector}`);
                            // Увеличиваем время ожидания после клика для загрузки транскрипта
                            await new Promise(resolve => setTimeout(resolve, 5000)); // Увеличено с 3 до 5 секунд
                            
                            const transcript = await this.extractTranscriptContent(page);
                            if (transcript && transcript.length > 30) {
                                return transcript;
                            }
                        }
                    } catch (e) {
                        continue;
                    }
                }

                // Также ищем по тексту
                const transcriptButtonTexts = [
                    'расшифровка',
                    'транскрипт', 
                    'transcript',
                    'show transcript',
                    'показать расшифровку',
                    'показать транскрипт'
                ];

                const transcriptText = await page.evaluate((texts: string[]) => {
                    // Ищем все кнопки и ссылки на странице
                    const allButtons = Array.from(document.querySelectorAll('button, a, yt-formatted-string, [role="button"]'));
                    
                    for (const button of allButtons) {
                        const buttonText = button.textContent?.toLowerCase().trim();
                        if (buttonText) {
                            for (const targetText of texts) {
                                if (buttonText.includes(targetText)) {
                                    (button as HTMLElement).click();
                                    return 'clicked';
                                }
                            }
                        }
                    }
                    return 'not_found';
                }, transcriptButtonTexts);

                if (transcriptText === 'clicked') {
                    console.log('✓ Clicked transcript button by text');
                    // Увеличиваем время ожидания после клика
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Увеличено с 3 до 5 секунд
                    
                    const transcript = await this.extractTranscriptContent(page);
                    if (transcript && transcript.length > 30) {
                        return transcript;
                    }
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                console.log('Strategy 1 failed:', errorMessage);
            }

            // Стратегия 2: Ищем кнопку "..." (More actions) и затем транскрипт
            try {
                const moreActionsSelectors = [
                    'button[aria-label*="More actions"]',
                    'button[aria-label*="Еще"]',
                    '#button[aria-haspopup="menu"]',
                    'ytd-menu-renderer button',
                    '#actions button'
                ];

                let moreActionsClicked = false;
                for (const selector of moreActionsSelectors) {
                    try {
                        await page.waitForSelector(selector, { timeout: 3000 });
                        await page.click(selector);
                        console.log(`✓ Clicked more actions button: ${selector}`);
                        moreActionsClicked = true;
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        break;
                    } catch (e) {
                        continue;
                    }
                }

                if (moreActionsClicked) {
                    // Ищем пункт меню с транскриптом
                    const transcriptFound = await page.evaluate(() => {
                        const menuItems = Array.from(document.querySelectorAll('ytd-menu-service-item-renderer, yt-formatted-string'));
                        for (const item of menuItems) {
                            const text = item.textContent?.toLowerCase();
                            if (text && (text.includes('transcript') || text.includes('транскрипт') || text.includes('расшифровка'))) {
                                (item as HTMLElement).click();
                                return true;
                            }
                        }
                        return false;
                    });

                    if (transcriptFound) {
                        console.log('✓ Found and clicked transcript menu item');
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        const transcript = await this.extractTranscriptContent(page);
                        if (transcript) return transcript;
                    }
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                console.log('Strategy 2 failed:', errorMessage);
            }

            // Стратегия 3: Пробуем найти уже открытую панель транскрипта
            try {
                const transcript = await this.extractTranscriptContent(page);
                if (transcript) {
                    console.log('✓ Found existing transcript panel');
                    return transcript;
                }
            } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                console.log('Strategy 3 failed:', errorMessage);
            }

            console.log('All transcript extraction strategies failed');
            return '';

        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(`✗ Failed to extract YouTube transcript: ${errorMessage}`);
            return '';
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }

    private async extractTranscriptContent(page: any): Promise<string> {
        try {
            // Ждем появления панели транскрипта (увеличено время ожидания)
            const panelSelectors = [
                'ytd-engagement-panel-section-list-renderer',
                '.ytd-transcript-body-renderer',
                '#segments-container',
                'ytd-transcript-segment-renderer',
                '[role="document"]',
                '#content-text',
                'ytd-transcript-renderer',
                'ytd-transcript-body-renderer',
                '[id*="transcript"]',
                '[class*="transcript"]',
                '[class*="Transcript"]'
            ];

            for (const selector of panelSelectors) {
                try {
                    // Увеличиваем таймаут ожидания панели транскрипта
                    await page.waitForSelector(selector, { timeout: 15000 }).catch(() => null); // Не выбрасываем ошибку, если не найдено
                    
                    const transcriptText = await page.evaluate((sel: string) => {
                        // Пробуем найти панель транскрипта
                        let panel = document.querySelector(sel);
                        
                        // Если не нашли по селектору, пробуем найти любую панель с транскриптом
                        if (!panel) {
                            const allPanels = document.querySelectorAll('[id*="transcript"], [class*="transcript"], [class*="Transcript"], ytd-transcript-segment-renderer');
                            if (allPanels.length > 0) {
                                panel = allPanels[0] as Element;
                            }
                        }
                        
                        if (!panel) return '';
                        
                        // Собираем текст из всех возможных элементов транскрипта
                        const textElements = panel.querySelectorAll(
                            'yt-formatted-string, .segment-text, [role="text"], .ytd-transcript-segment-renderer, #content-text, ytd-transcript-segment-renderer yt-formatted-string, [class*="segment"], [class*="Segment"]'
                        );
                        
                        // Если не нашли элементы, пробуем получить весь текст панели
                        if (textElements.length === 0) {
                            const allText = panel.textContent || '';
                            if (allText && allText.trim().length > 30) {
                                return allText.trim();
                            }
                        }
                        
                        const texts: string[] = [];
                        textElements.forEach((el: Element) => {
                            const text = el.textContent?.trim();
                            if (text && 
                                text.length > 5 && // Уменьшено с 10 до 5 для более коротких фраз
                                !text.match(/^\d+:\d+$/) && // исключаем временные метки
                                !text.match(/^\d+:\d+:\d+$/) && // исключаем временные метки с секундами
                                !text.includes('›') &&
                                !text.match(/^0:00$/) &&
                                !text.match(/^Show transcript$/i) &&
                                !text.match(/^Показать расшифровку$/i) &&
                                !text.match(/^transcript$/i) &&
                                !text.match(/^расшифровка$/i)) {
                                texts.push(text);
                            }
                        });
                        
                        return texts.join(' ').trim();
                    }, selector);

                    if (transcriptText && transcriptText.length > 30) {
                        const normalized = this.normalizeTranscript(transcriptText);
                        if (normalized.length > 30) {
                            console.log(`✓ Extracted transcript from ${selector}: ${normalized.length} chars`);
                            return normalized;
                        } else {
                            console.log(`   ⚠️ Transcript too short after normalization: ${normalized.length} chars`);
                        }
                    }
                } catch (e) {
                    // Продолжаем поиск с другими селекторами
                    continue;
                }
            }
            
            // Дополнительная попытка: ищем текст напрямую на странице
            try {
                const allText = await page.evaluate(() => {
                    const segments = Array.from(document.querySelectorAll('ytd-transcript-segment-renderer'));
                    const texts: string[] = [];
                    segments.forEach((segment: Element) => {
                        const textEl = segment.querySelector('yt-formatted-string');
                        if (textEl) {
                            const text = textEl.textContent?.trim();
                            if (text && text.length > 10) {
                                texts.push(text);
                            }
                        }
                    });
                    return texts.join(' ').trim();
                });
                
                if (allText && allText.length > 30) {
                    const normalized = this.normalizeTranscript(allText);
                    if (normalized.length > 30) {
                        console.log(`✓ Extracted transcript from segments: ${normalized.length} chars`);
                        return normalized;
                    }
                }
            } catch (e) {
                // Игнорируем ошибки
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.log('Transcript content extraction failed:', errorMessage);
        }
        return '';
    }

    /**
     * Извлекает транскрипт YouTube видео через yt-dlp
     */
    private async extractTranscriptWithYtDlp(url: string): Promise<string | null> {
        try {
            // @ts-ignore - yt-dlp-exec types may not быть доступны
            const ytdlp = (await import('yt-dlp-exec')).default;
            
            // Очищаем URL от параметров времени (t=26s и т.д.), которые могут вызывать проблемы
            const cleanUrl = url.split('&t=')[0].split('#t=')[0];
            
            // Сначала получаем информацию о доступных субтитрах
            let infoResult;
            try {
                infoResult = await ytdlp(cleanUrl, {
                    listSubs: true,
                    skipDownload: true,
                    quiet: true,
                    noWarnings: true,
                });
            } catch (listSubsError: any) {
                const errorMsg = listSubsError.message || '';
                // Если ошибка "Sign in to confirm you're not a bot", пропускаем yt-dlp и возвращаем null
                // Система попробует другие методы (Puppeteer, youtube-transcript)
                if (errorMsg.includes('Sign in to confirm') || errorMsg.includes('not a bot')) {
                    console.log(`   ⚠️ yt-dlp blocked by YouTube (bot detection). Skipping yt-dlp, will try other methods.`);
                    return null;
                }
                throw listSubsError;
            }
            
            // Пробуем скачать автоматически сгенерированные субтитры или обычные
            // Используем временный файл для субтитров
            const tempDir = os.tmpdir();
            const tempSubsFile = path.join(tempDir, `subs_${Date.now()}.vtt`);
            
            try {
                // Пробуем скачать автоматические субтитры (если доступны)
                await ytdlp(cleanUrl, {
                    writeAutoSub: true,
                    subLang: 'ru,en,uk', // Приоритет языков
                    skipDownload: true,
                    output: tempSubsFile.replace('.vtt', ''),
                    quiet: true,
                    noWarnings: true,
                });
                
                // Ищем скачанный файл субтитров
                const glob = await import('glob');
                
                // yt-dlp создает файлы с расширениями .vtt, .srt и т.д.
                const possibleFiles = glob.sync(`${tempSubsFile.replace('.vtt', '')}.*`);
                const subFile = possibleFiles.find(f => 
                    f.endsWith('.vtt') || f.endsWith('.srt') || f.endsWith('.ttml')
                );
                
                if (subFile && await fs.pathExists(subFile)) {
                    let subContent = await fs.readFile(subFile, 'utf-8');
                    
                    // Очищаем VTT формат (убираем временные метки и теги)
                    subContent = subContent
                        .replace(/<[^>]+>/g, '') // Убираем HTML теги
                        .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '') // Убираем временные метки
                        .replace(/^\d+$/gm, '') // Убираем номера строк
                        .replace(/WEBVTT|Kind:|Language:/gi, '')
                        .replace(/\n{3,}/g, '\n\n') // Убираем множественные переносы строк
                        .split('\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0 && !line.match(/^\d+$/))
                        .join(' ')
                        .trim();
                    
                    // Удаляем временный файл
                    await fs.remove(subFile);
                    
                    if (subContent && subContent.length > 30) {
                        const normalized = this.normalizeTranscript(subContent);
                        if (normalized.length > 30) {
                            console.log(`✓ Extracted transcript via yt-dlp: ${normalized.length} chars`);
                            return normalized;
                        }
                    }
                }
            } catch (downloadError: any) {
                const errorMsg = downloadError.message || '';
                // Если ошибка "Sign in to confirm you're not a bot", пропускаем yt-dlp
                if (errorMsg.includes('Sign in to confirm') || errorMsg.includes('not a bot')) {
                    console.log(`   ⚠️ yt-dlp blocked by YouTube (bot detection). Skipping yt-dlp.`);
                    return null;
                }
                
                // Если автоматические субтитры недоступны, пробуем обычные
                try {
                    await ytdlp(cleanUrl, {
                        writeSub: true,
                        subLang: 'ru,en,uk',
                        skipDownload: true,
                        output: tempSubsFile.replace('.vtt', ''),
                        quiet: true,
                        noWarnings: true,
                    });
                    
                    const glob = await import('glob');
                    const possibleFiles = glob.sync(`${tempSubsFile.replace('.vtt', '')}.*`);
                    const subFile = possibleFiles.find(f => 
                        f.endsWith('.vtt') || f.endsWith('.srt') || f.endsWith('.ttml')
                    );
                    
                    if (subFile && await fs.pathExists(subFile)) {
                        let subContent = await fs.readFile(subFile, 'utf-8');
                        subContent = subContent
                            .replace(/<[^>]+>/g, '')
                            .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '')
                            .replace(/^\d+$/gm, '')
                            .replace(/WEBVTT|Kind:|Language:/gi, '')
                            .replace(/\n{3,}/g, '\n\n')
                            .split('\n')
                            .map(line => line.trim())
                            .filter(line => line.length > 0 && !line.match(/^\d+$/))
                            .join(' ')
                            .trim();
                        
                        await fs.remove(subFile);
                        
                        if (subContent && subContent.length > 30) {
                            const normalized = this.normalizeTranscript(subContent);
                            if (normalized.length > 30) {
                                console.log(`✓ Extracted transcript via yt-dlp (manual subs): ${normalized.length} chars`);
                                return normalized;
                            }
                        }
                    }
                } catch (manualSubError: any) {
                    const errorMsg = manualSubError.message || '';
                    // Если ошибка "Sign in to confirm you're not a bot", пропускаем yt-dlp
                    if (errorMsg.includes('Sign in to confirm') || errorMsg.includes('not a bot')) {
                        console.log(`   ⚠️ yt-dlp blocked by YouTube (bot detection). Skipping yt-dlp.`);
                        return null;
                    }
                    // Оба метода провалились
                    console.log(`   ⚠️ Both auto and manual subtitles unavailable via yt-dlp`);
                }
            }
            
            return null;
        } catch (error: any) {
            const errorMsg = error.message || '';
            // Если ошибка "Sign in to confirm you're not a bot", не логируем как ошибку
            if (errorMsg.includes('Sign in to confirm') || errorMsg.includes('not a bot')) {
                console.log(`   ⚠️ yt-dlp blocked by YouTube (bot detection). Skipping yt-dlp, will try other methods.`);
            } else {
                console.warn(`yt-dlp transcript extraction failed: ${errorMsg}`);
            }
            return null;
        }
    }

    /**
     * Быстро получает метаданные видео через yt-dlp (без Puppeteer)
     */
    private async fetchMetadataWithYtDlp(url: string): Promise<ExtractedContent | null> {
        try {
            // @ts-ignore - yt-dlp-exec types may not быть доступны
            const ytdlp = (await import('yt-dlp-exec')).default;
            
            // Очищаем URL от параметров времени (t=26s и т.д.), которые могут вызывать проблемы
            const cleanUrl = url.split('&t=')[0].split('#t=')[0];
            
            let rawResult;
            try {
                rawResult = await ytdlp(cleanUrl, {
                    dumpSingleJson: true,
                    noWarnings: true,
                    simulate: true,
                    skipDownload: true,
                    quiet: true,
                });
            } catch (error: any) {
                const errorMsg = error.message || '';
                // Если ошибка "Sign in to confirm you're not a bot", возвращаем null
                // Система попробует другие методы (Puppeteer)
                if (errorMsg.includes('Sign in to confirm') || errorMsg.includes('not a bot')) {
                    console.log(`   ⚠️ yt-dlp metadata extraction blocked by YouTube (bot detection). Skipping yt-dlp, will try other methods.`);
                    return null;
                }
                throw error;
            }

            const parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
            const title = parsed?.title || parsed?.fulltitle;
            const description = parsed?.description || parsed?.shortDescription;

            if (!title && !description) {
                return null;
            }

            const contentParts: string[] = [];
            if (title) contentParts.push(`Название: ${title}`);
            if (description) contentParts.push(`\n\nОписание: ${description}`);

            const content =
                contentParts.join('') +
                '\n\n⚠️ ВАЖНО: Это только метаданные видео (название и описание). Полная расшифровка видео недоступна. Анализ проводится ТОЛЬКО на основе этих метаданных, без доступа к полному содержанию видео.';

            console.log('✓ Extracted metadata via yt-dlp');
            return { content, sourceType: 'metadata' };
        } catch (error: any) {
            const errorMsg = error.message || '';
            // Если ошибка "Sign in to confirm you're not a bot", не логируем как ошибку
            if (errorMsg.includes('Sign in to confirm') || errorMsg.includes('not a bot')) {
                console.log(`   ⚠️ yt-dlp metadata extraction blocked by YouTube (bot detection). Skipping yt-dlp, will try other methods.`);
            } else {
                console.warn(`yt-dlp metadata extraction failed: ${errorMsg}`);
            }
            return null;
        }
    }

    /**
     * Извлекает контент из поста Twitter/X
     * Twitter посты — это текст, не видео. Извлекаем текст твита через og:description, [data-testid="tweetText"] или мета-теги.
     */
    private async extractTwitterPostContent(url: string): Promise<ExtractedContent> {
        try {
            console.log(`🐦 [Twitter/X] Extracting post content from: ${url}`);
            
            // Метод 1: ScrapingBee (og:description и twitter:description содержат текст твита)
            try {
                const scrapingBeeContent = await this.extractWithScrapingBee(url);
                if (scrapingBeeContent) {
                    const cheerio = await import('cheerio');
                    const $ = cheerio.load(scrapingBeeContent);
                    
                    // Twitter/X помещает текст твита в og:description и twitter:description
                    const ogDesc = $('meta[property="og:description"]').attr('content');
                    const twitterDesc = $('meta[name="twitter:description"]').attr('content');
                    const ogTitle = $('meta[property="og:title"]').attr('content');
                    
                    const tweetText = ogDesc || twitterDesc || '';
                    
                    if (tweetText.trim().length > 20) {
                        let content = tweetText.trim();
                        // Добавляем контекст автора из og:title (формат "Author on X: Tweet text")
                        if (ogTitle && ogTitle.trim().length > 0 && !content.includes(ogTitle)) {
                            content = `Автор: ${ogTitle}\n\nТекст поста:\n${content}`;
                        }
                        console.log(`✓ Extracted Twitter/X post via ScrapingBee (${tweetText.length} chars)`);
                        return { content, sourceType: 'article' };
                    }
                }
            } catch (scrapingBeeError: any) {
                console.log(`⚠️ ScrapingBee failed for Twitter/X: ${scrapingBeeError.message}`);
            }
            
            // Метод 2: Puppeteer (селектор [data-testid="tweetText"] для текста твита)
            try {
                const launchOptions = await this.getPuppeteerLaunchOptions();
                const browser = await puppeteer.launch(launchOptions);
                let tweetContent = '';
                try {
                    const page = await browser.newPage();
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    
                    await new Promise(resolve => setTimeout(resolve, 10000));
                    
                    tweetContent = await page.evaluate(() => {
                        // Twitter/X использует data-testid="tweetText" для текста твита
                        const tweetEl = document.querySelector('[data-testid="tweetText"]');
                        if (tweetEl) {
                            return tweetEl.textContent?.trim() || '';
                        }
                        
                        // Fallback: og:description из meta
                        const ogDesc = document.querySelector('meta[property="og:description"]');
                        if (ogDesc) {
                            return ogDesc.getAttribute('content') || '';
                        }
                        
                        const twitterDesc = document.querySelector('meta[name="twitter:description"]');
                        if (twitterDesc) {
                            return twitterDesc.getAttribute('content') || '';
                        }
                        
                        // Fallback: article
                        const article = document.querySelector('article');
                        if (article) {
                            article.querySelectorAll('script, style, nav, header, footer, aside, button, [role="button"]').forEach(el => el.remove());
                            return article.textContent?.trim() || '';
                        }
                        
                        return '';
                    });
                } finally {
                    await browser.close().catch(() => {});
                }
                
                if (tweetContent && tweetContent.trim().length > 20) {
                    console.log(`✓ Extracted Twitter/X post via Puppeteer (${tweetContent.length} chars)`);
                    return { content: tweetContent.trim(), sourceType: 'article' };
                }
            } catch (puppeteerError: any) {
                console.warn(`⚠️ Puppeteer failed for Twitter/X: ${puppeteerError.message}`);
            }
            
            // Метод 3: extractBasicMetadata (og:tags через HTTP)
            try {
                const basicMetadata = await this.extractBasicMetadata(url);
                if (basicMetadata && basicMetadata.content && basicMetadata.content.trim().length > 20) {
                    console.log(`✓ Extracted Twitter/X post via basic metadata (${basicMetadata.content.length} chars)`);
                    return basicMetadata;
                }
            } catch (metadataError: any) {
                console.warn(`⚠️ Basic metadata failed for Twitter/X: ${metadataError.message}`);
            }
            
            // Метод 4: Простой fetch для og:tags (Twitter может отдавать их без JS)
            try {
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
                    }
                });
                const html = await response.text();
                const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
                const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
                
                const tweetText = ogDescMatch?.[1] || '';
                const title = ogTitleMatch?.[1] || '';
                
                if (tweetText.trim().length > 20) {
                    let content = tweetText.trim();
                    if (title) {
                        content = `Автор: ${title}\n\nТекст поста:\n${content}`;
                    }
                    console.log(`✓ Extracted Twitter/X post via fetch (${tweetText.length} chars)`);
                    return { content, sourceType: 'article' };
                }
            } catch (fetchError: any) {
                console.warn(`⚠️ Fetch failed for Twitter/X: ${fetchError.message}`);
            }
            
            console.warn(`⚠️ All Twitter/X extraction methods failed. Returning minimal metadata.`);
            return {
                content: `⚠️ Не удалось извлечь полный текст поста Twitter/X. Возможно, пост требует авторизации или удалён.\n\nURL: ${url}`,
                sourceType: 'metadata' as const
            };
        } catch (error: any) {
            console.error(`❌ Failed to extract Twitter/X content: ${error.message}`);
            throw new Error(`Не удалось извлечь контент из поста Twitter/X: ${error.message}`);
        }
    }

    /**
     * Извлекает контент из Telegram поста
     */
    private async extractTelegramPostContent(url: string): Promise<ExtractedContent> {
        try {
            console.log(`📱 [Telegram] Extracting post content from: ${url}`);
            
            // Пробуем извлечь через Puppeteer (самый надежный способ для Telegram)
            try {
                const launchOptions = await this.getPuppeteerLaunchOptions();
                try {
                    const browser = await puppeteer.launch(launchOptions);
                    const page = await browser.newPage();
                    
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    
                    // Ждем загрузки контента
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    
                    // Извлекаем текст поста из Telegram
                    const postContent = await page.evaluate(() => {
                        // Ищем основной текст поста
                        const selectors = [
                            '.tgme_widget_message_text',
                            '.message-text',
                            '[class*="message_text"]',
                            'article .text',
                            '.tgme_widget_message_bubble'
                        ];
                        
                        for (const selector of selectors) {
                            const element = document.querySelector(selector);
                            if (element) {
                                return element.textContent?.trim() || '';
                            }
                        }
                        
                        // Fallback: ищем любой текст в article или main
                        const article = document.querySelector('article, main, .tgme_widget_message');
                        if (article) {
                            // Удаляем ненужные элементы
                            article.querySelectorAll('script, style, nav, header, footer, aside, button, .tgme_widget_message_date, .tgme_widget_message_views').forEach(el => el.remove());
                            return article.textContent?.trim() || '';
                        }
                        
                        return '';
                    });
                    
                    await browser.close();
                    
                    if (postContent && postContent.trim().length > 30) {
                        console.log(`✓ Extracted Telegram post content via Puppeteer (${postContent.length} chars)`);
                        return { content: postContent, sourceType: 'telegram' };
                    }
                } catch (launchError: any) {
                    if (launchError.message?.includes('Target crashed') || launchError.message?.includes('Protocol error')) {
                        console.warn(`⚠️ Puppeteer unavailable for Telegram post, trying HTTP fallback...`);
                    } else {
                        throw launchError;
                    }
                }
            } catch (puppeteerError: any) {
                console.warn(`⚠️ Puppeteer failed for Telegram post: ${puppeteerError.message}`);
            }
            
            // Fallback: извлекаем через HTTP запрос (og:description может содержать полный текст)
            try {
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
                    },
                    signal: AbortSignal.timeout(10000)
                });
                
                const html = await response.text();
                const cheerio = await import('cheerio');
                const $ = cheerio.load(html);
                
                // Извлекаем og:description (Telegram часто помещает весь текст поста туда)
                const ogDescription = $('meta[property="og:description"]').attr('content') || '';
                const ogTitle = $('meta[property="og:title"]').attr('content') || '';
                
                // Если og:description достаточно длинный (>100 символов), считаем это полным текстом поста
                if (ogDescription && ogDescription.trim().length > 100) {
                    const content = ogTitle ? `${ogTitle}\n\n${ogDescription}` : ogDescription;
                    console.log(`✓ Extracted Telegram post content from og:description (${content.length} chars)`);
                    return { content, sourceType: 'telegram' };
                }
                
                // Если og:description короткий, пробуем найти текст в HTML
                const messageText = $('.tgme_widget_message_text, .message-text, [class*="message_text"]').text().trim();
                if (messageText && messageText.length > 30) {
                    console.log(`✓ Extracted Telegram post content from HTML (${messageText.length} chars)`);
                    return { content: messageText, sourceType: 'telegram' };
                }
                
                // Если ничего не нашли, используем og:description как есть
                if (ogDescription && ogDescription.trim().length > 30) {
                    const content = ogTitle ? `${ogTitle}\n\n${ogDescription}` : ogDescription;
                    console.log(`✓ Using og:description as Telegram post content (${content.length} chars)`);
                    return { content, sourceType: 'telegram' };
                }
            } catch (httpError: any) {
                console.warn(`⚠️ HTTP extraction failed for Telegram post: ${httpError.message}`);
            }
            
            // Если ничего не получилось, возвращаем минимальную информацию
            console.warn(`⚠️ Failed to extract Telegram post content`);
            return {
                content: `⚠️ Не удалось извлечь полный текст Telegram поста.\n\nURL: ${url}`,
                sourceType: 'telegram' as const
            };
        } catch (error: any) {
            console.error(`✗ Failed to extract Telegram post: ${error.message}`);
            return {
                content: `⚠️ Ошибка при извлечении Telegram поста: ${error.message}\n\nURL: ${url}`,
                sourceType: 'telegram' as const
            };
        }
    }

    /**
     * Определяет видеоплатформу по URL
     */
    private detectVideoPlatform(url: string): string | null {
        const patterns: { [key: string]: RegExp[] } = {
            youtube: [
                /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/|shorts\/|.+\?v=)?([^"&?\/\s]{11})/,
            ],
            vk: [
                /(?:https?:\/\/)?(?:www\.)?(?:vk\.com|vkontakte\.ru)\/video(-?\d+_\d+)/,
                /(?:https?:\/\/)?(?:www\.)?vk\.com\/.*video/,
                /(?:https?:\/\/)?(?:www\.)?vkvideo\.ru\/video(-?\d+_\d+)/,
            ],
            tiktok: [
                /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com)\/.+/,
            ],
            rutube: [
                /(?:https?:\/\/)?(?:www\.)?rutube\.ru\/video\/([a-zA-Z0-9]+)/,
            ],
            dzen: [
                /(?:https?:\/\/)?(?:www\.)?dzen\.ru\/video\/watch\/([a-zA-Z0-9]+)/,
                /(?:https?:\/\/)?(?:www\.)?dzen\.ru\/video\/([a-zA-Z0-9]+)/,
            ],
            yandex: [
                /(?:https?:\/\/)?(?:www\.)?yandex\.ru\/video\/(?:search|preview)\?.*/,
            ],
            instagram: [
                /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|p)\/([a-zA-Z0-9_-]+)/,
            ],
            facebook: [
                /(?:https?:\/\/)?(?:www\.)?(?:facebook\.com|fb\.com)\/watch\/?.*/,
            ],
            twitter: [
                /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/.+\/status\/\d+/,
            ],
        };

        for (const [platform, platformPatterns] of Object.entries(patterns)) {
            if (platformPatterns.some(pattern => pattern.test(url))) {
                return platform;
            }
        }

        return null;
    }

    private isYoutubeUrl(url: string): boolean {
        return this.detectVideoPlatform(url) === 'youtube';
    }

    private async scrapeArticleWithPuppeteer(url: string): Promise<ExtractedContent> {
        try {
            const parsed = new URL(url.trim().split('?')[0].split('#')[0] || url);
            const host = parsed.hostname.toLowerCase();
            const pathname = parsed.pathname.replace(/\/+$/, '').replace(/^\/+/, '');
            if ((host === 'twitter.com' || host === 'x.com') && /^[a-zA-Z0-9_]+$/.test(pathname) && !pathname.toLowerCase().startsWith('i')) {
                throw new Error('TWITTER_PROFILE_URL');
            }
        } catch (e: any) {
            if (e?.message === 'TWITTER_PROFILE_URL') throw e;
        }
        console.log(`Attempting to scrape article with Puppeteer from: ${url}`);
        let browser = null;
        try {
            console.log('Initializing headless browser...');
            const launchOptions = await this.getPuppeteerLaunchOptions();
            browser = await puppeteer.launch(launchOptions);
            console.log('✓ Headless browser initialized.');

            const page = await browser.newPage();
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            
            // A more generic approach to get main content
            const content = await page.evaluate(() => {
                const mainContentSelectors = ['article', 'main', '.post-content', '.article-body', 'body'];
                let mainEl = null;
                for (const selector of mainContentSelectors) {
                    mainEl = document.querySelector(selector);
                    if (mainEl) break;
                }
                
                if (!mainEl) return 'Could not find main content.';

                // Remove non-essential elements
                mainEl.querySelectorAll('script, style, nav, header, footer, aside, form, button, .comments, #comments').forEach((el: Element) => el.remove());

                // Get text, preferring longer paragraphs
                const paragraphs = Array.from(mainEl.querySelectorAll('p, h1, h2, h3, li, pre, code'));
                return paragraphs
                    .map(p => p.textContent)
                    .filter((text): text is string => text !== null && text.trim().length > 20)
                    .join('\n\n');
            });
            
            if (content.trim().length < 100) {
                throw new Error('Scraped content is too short. The article might be behind a paywall or protected.');
            }

            console.log(`✓ Successfully scraped article with Puppeteer (${content.length} chars)`);
            return { content, sourceType: 'article' };

        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(`✗ Puppeteer scraping failed: ${errorMessage}`);
            // Выбрасываем ошибку вместо возврата сообщения об ошибке как контента
            throw new Error(`Не удалось извлечь контент из статьи. ${errorMessage}`);
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }

    /**
     * Универсальный метод извлечения метаданных видео через Puppeteer
     */
    private async extractVideoMetadata(url: string, platform: string): Promise<ExtractedContent | null> {
        let browser = null;
        try {
            console.log(`Extracting metadata from ${platform} video: ${url}`);
            const launchOptions = await this.getPuppeteerLaunchOptions();
            browser = await puppeteer.launch(launchOptions);
            const page = await browser.newPage();
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
            });

            // Для YouTube используем domcontentloaded; в Railway/Docker страницы грузятся медленно
            // Для VK увеличиваем время ожидания и используем networkidle для полной загрузки
            const waitUntil = platform === 'vk' ? 'networkidle2' : 'domcontentloaded';
            const timeout = platform === 'vk' ? 90000 : (platform === 'youtube' ? 60000 : 60000); // YouTube: 60 сек для Railway
            
            await page.goto(url, { 
                waitUntil,
                timeout
            });

            // Ждем загрузки контента (для VK нужно больше времени)
            const waitTime = platform === 'vk' ? 5000 : 3000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            // Для VK дополнительно ждем загрузки видео-плеера
            if (platform === 'vk') {
                try {
                    await page.waitForSelector('video, [class*="video"], [class*="Video"]', { timeout: 5000 });
                } catch (e) {
                    // Игнорируем, если видео-плеер не найден
                }
            }

            // Извлекаем метаданные в зависимости от платформы
            const metadata = await page.evaluate((platform: string) => {
                let title = '';
                let description = '';
                let additionalText = '';

                // Общие селекторы для названия
                const titleSelectors = [
                    'h1',
                    'meta[property="og:title"]',
                    'meta[name="twitter:title"]',
                    '[class*="title"]',
                    '[class*="Title"]',
                    'title'
                ];

                // Общие селекторы для описания
                const descriptionSelectors = [
                    'meta[property="og:description"]',
                    'meta[name="twitter:description"]',
                    'meta[name="description"]',
                    '[class*="description"]',
                    '[class*="Description"]',
                ];

                // Платформо-специфичные селекторы (ОБНОВЛЕНО с универсальными вариантами)
                const platformSelectors: { [key: string]: { title: string[], description: string[], text?: string[], comments?: string[] } } = {
                    vk: {
                        // Актуальные селекторы для нового дизайна VK + fallback на старые
                        title: [
                            // Новый дизайн VK
                            '[class*="VideoPageTitleContainer"] [class*="title"]',
                            '.VideoPageTitleContainer_title__*',
                            '[class*="VideoPage"] [class*="title"]',
                            '[class*="VideoInfo"] [class*="title"]',
                            // Старый дизайн
                            'h1.wall_post_text',
                            '.video_page_title',
                            '.video_info_title',
                            '.mv_title',
                            // Универсальные
                            'h1[class*="title"]',
                            'h1[class*="Title"]',
                            '[data-testid="video-title"]',
                            '[data-l="video-title"]',
                            '[data-l="t,video-title"]',
                            'h1',
                            // Meta теги (самые надежные)
                            'meta[property="og:title"]',
                            'meta[name="twitter:title"]',
                            'title'
                        ],
                        description: [
                            // Новый дизайн VK
                            '[class*="VideoPageTitleContainer"] [class*="description"]',
                            '.VideoPageTitleContainer_description__*',
                            '[class*="VideoPage"] [class*="description"]',
                            '[class*="VideoInfo"] [class*="description"]',
                            // Старый дизайн
                            '.video_info_desc',
                            '.mv_description',
                            'h1.wall_post_text',
                            // Универсальные
                            '[class*="description"]',
                            '[class*="Description"]',
                            '[data-testid="video-description"]',
                            '[data-l="video-description"]',
                            '[data-l="t,video-description"]',
                            // Meta теги (самые надежные)
                            'meta[property="og:description"]',
                            'meta[name="twitter:description"]',
                            'meta[name="description"]'
                        ],
                        text: [
                            '.wall_post_text', 
                            '.video_info_desc', 
                            '.video_info_text',
                            '[class*="video"] [class*="text"]',
                            '[class*="post"] [class*="text"]',
                            '[class*="VideoPage"] [class*="text"]'
                        ],
                        comments: [
                            '[class*="comment"] [class*="text"]',
                            '[class*="reply"] [class*="text"]',
                            '.reply_text', 
                            '.comment_text', 
                            '.wall_item_text',
                            '[data-testid="comment-text"]'
                        ]
                    },
                    tiktok: {
                        title: ['h1[data-e2e="browse-video-desc"]', '.video-meta-title'],
                        description: ['[data-e2e="browse-video-desc"]', '.video-meta-desc'],
                        text: ['[data-e2e="browse-video-desc"]']
                    },
                    rutube: {
                        // Актуальные селекторы для нового дизайна RuTube + fallback
                        title: [
                            '.video-info__title',
                            '[class*="video"] [class*="title"]',
                            '[class*="Video"] [class*="Title"]',
                            '.video-title', 
                            'h1.video-title',
                            'h1[class*="title"]',
                            'h1',
                            'meta[property="og:title"]',
                            'meta[name="twitter:title"]'
                        ],
                        description: [
                            '.video-info__description-text',
                            '[class*="video"] [class*="description"]',
                            '[class*="description"]',
                            '.video-description', 
                            '.description',
                            '.video-info__description',
                            'meta[property="og:description"]',
                            'meta[name="twitter:description"]'
                        ],
                        text: [
                            '.video-info__description-text',
                            '[class*="video"] [class*="text"]',
                            '.video-description', 
                            '.video-info__description',
                            '[class*="description"]'
                        ],
                        comments: [
                            '[class*="comment"] [class*="text"]',
                            '.comment-text', 
                            '.comment__text',
                            '[class*="comment"]',
                            '[data-testid="comment-text"]'
                        ]
                    },
                    dzen: {
                        title: ['.video-card-title', 'h1'],
                        description: ['.video-card-description', '.description'],
                        text: ['.video-card-description']
                    },
                    instagram: {
                        title: ['h1', 'article h1'],
                        description: ['meta[property="og:description"]'],
                        text: ['article span']
                    },
                    facebook: {
                        title: ['h1', '[data-testid="post_message"]'],
                        description: ['[data-testid="post_message"]'],
                        text: ['[data-testid="post_message"]']
                    },
                    twitter: {
                        title: ['h1', '[data-testid="tweetText"]'],
                        description: ['[data-testid="tweetText"]'],
                        text: ['[data-testid="tweetText"]']
                    }
                };

                // Пробуем платформо-специфичные селекторы
                const selectors = platformSelectors[platform] || {};
                const allTitleSelectors = [...(selectors.title || []), ...titleSelectors];
                const allDescSelectors = [...(selectors.description || []), ...descriptionSelectors];
                const textSelectors = selectors.text || [];

                // Извлекаем название
                for (const selector of allTitleSelectors) {
                    try {
                        if (selector.startsWith('meta')) {
                            const meta = document.querySelector(selector);
                            if (meta) {
                                title = meta.getAttribute('content') || '';
                                if (title) break;
                            }
                        } else {
                            // Пробуем querySelector, если не работает - пробуем querySelectorAll с фильтрацией
                            const el = document.querySelector(selector);
                            if (el) {
                                title = el.textContent?.trim() || '';
                                if (title && title.length > 5) break;
                            } else if (selector.includes('*')) {
                                // Для селекторов с * пробуем найти через querySelectorAll
                                const allElements = Array.from(document.querySelectorAll(selector.replace(/\*/g, '')));
                                for (const elem of allElements) {
                                    const text = elem.textContent?.trim();
                                    if (text && text.length > 5) {
                                        title = text;
                                        break;
                                    }
                                }
                                if (title) break;
                            }
                        }
                    } catch (e) {
                        // Игнорируем ошибки невалидных селекторов
                        continue;
                    }
                }

                // Извлекаем описание
                for (const selector of allDescSelectors) {
                    try {
                        if (selector.startsWith('meta')) {
                            const meta = document.querySelector(selector);
                            if (meta) {
                                description = meta.getAttribute('content') || '';
                                if (description) break;
                            }
                        } else {
                            const el = document.querySelector(selector);
                            if (el) {
                                description = el.textContent?.trim() || '';
                                if (description && description.length > 10) break;
                            } else if (selector.includes('*')) {
                                // Для селекторов с * пробуем найти через querySelectorAll
                                const allElements = Array.from(document.querySelectorAll(selector.replace(/\*/g, '')));
                                for (const elem of allElements) {
                                    const text = elem.textContent?.trim();
                                    if (text && text.length > 10) {
                                        description = text;
                                        break;
                                    }
                                }
                                if (description) break;
                            }
                        }
                    } catch (e) {
                        // Игнорируем ошибки невалидных селекторов
                        continue;
                    }
                }

                // Извлекаем дополнительный текст (комментарии, подписи и т.д.)
                if (textSelectors.length > 0) {
                    const texts: string[] = [];
                    textSelectors.forEach(selector => {
                        const elements = Array.from(document.querySelectorAll(selector));
                        elements.forEach(el => {
                            const text = el.textContent?.trim();
                            if (text && text.length > 20 && text !== title && text !== description) {
                                texts.push(text);
                            }
                        });
                    });
                    additionalText = texts.slice(0, 3).join(' '); // Берем первые 3 элемента
                }
                
                // Извлекаем комментарии для дополнительного контекста (если доступны)
                const commentSelectors = selectors.comments || [];
                if (commentSelectors.length > 0) {
                    const comments: string[] = [];
                    commentSelectors.forEach(selector => {
                        const elements = Array.from(document.querySelectorAll(selector));
                        elements.forEach(el => {
                            const text = el.textContent?.trim();
                            if (text && text.length > 10) {
                                comments.push(text);
                            }
                        });
                    });
                    // Берем первые 5 комментариев для контекста
                    if (comments.length > 0) {
                        const commentsText = comments.slice(0, 5).join(' | ');
                        if (additionalText) {
                            additionalText += `\n\nКомментарии: ${commentsText}`;
                        } else {
                            additionalText = `Комментарии: ${commentsText}`;
                        }
                    }
                }

                return { title, description, additionalText };
            }, platform);

            if (metadata.title || metadata.description || metadata.additionalText) {
                const contentParts: string[] = [];
                if (metadata.title) contentParts.push(`Название: ${metadata.title}`);
                if (metadata.description) contentParts.push(`\n\nОписание: ${metadata.description}`);
                if (metadata.additionalText) contentParts.push(`\n\nДополнительная информация: ${metadata.additionalText}`);

                const content = contentParts.join('') + 
                    '\n\n⚠️ ВАЖНО: Это только метаданные видео (название, описание' + 
                    (metadata.additionalText ? ', дополнительная информация со страницы' : '') + 
                    '). Полная расшифровка видео недоступна. Анализ проводится ТОЛЬКО на основе этих метаданных, без доступа к полному содержанию видео.';

                console.log(`✓ Extracted metadata from ${platform} (title: ${metadata.title ? 'yes' : 'no'}, desc: ${metadata.description ? 'yes' : 'no'})`);
                return { content, sourceType: 'metadata' };
            }

            return null;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(`✗ Failed to extract metadata from ${platform}: ${errorMessage}`);
            return null;
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }

    /**
     * Финальный fallback: извлекает базовые метаданные (og:title, og:description) 
     * Сначала пробует простой HTTP-запрос (без браузера), потом Puppeteer с коротким таймаутом
     */
    private async extractBasicMetadata(url: string): Promise<ExtractedContent | null> {
        // Сначала пробуем простой HTTP-запрос (не требует браузера)
        try {
            console.log(`Extracting basic metadata via HTTP fetch from: ${url}`);
            
            // Используем AbortController для таймаута
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // Увеличиваем до 15 секунд
            
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
                },
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const html = await response.text();
            
            // Извлекаем og:tags и title из HTML через regex (более надежный парсинг)
            const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
            const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
            
            // Дополнительные селекторы для описания (YouTube может использовать разные форматы)
            const metaDescMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
            const itemDescMatch = html.match(/<meta\s+itemprop=["']description["']\s+content=["']([^"']+)["']/i);
            
            // Для YouTube также пробуем извлечь дополнительные данные из JSON-LD
            let jsonLdData: any = null;
            let jsonLdDescription = '';
            try {
                const jsonLdMatches = html.match(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi);
                if (jsonLdMatches) {
                    for (const match of jsonLdMatches) {
                        try {
                            const jsonContent = match.replace(/<script[^>]*>|<\/script>/gi, '').trim();
                            const parsed = JSON.parse(jsonContent);
                            if (parsed.name || parsed.headline || parsed.description) {
                                jsonLdData = parsed;
                                // Извлекаем описание из разных полей JSON-LD
                                jsonLdDescription = parsed.description || parsed.about?.description || parsed.abstract || '';
                                break;
                            }
                            // Также проверяем массивы в JSON-LD
                            if (Array.isArray(parsed)) {
                                for (const item of parsed) {
                                    if (item.description || item.name) {
                                        jsonLdData = item;
                                        jsonLdDescription = item.description || '';
                                        break;
                                    }
                                }
                            }
                        } catch (e) {
                            // Игнорируем ошибки парсинга JSON
                        }
                    }
                }
            } catch (e) {
                // Игнорируем ошибки извлечения JSON-LD
            }
            
            // Для YouTube также пробуем извлечь описание из ytInitialPlayerResponse
            let ytDescription = '';
            try {
                const ytPlayerMatch = html.match(/var\s+ytInitialPlayerResponse\s*=\s*({[\s\S]*?});/);
                if (ytPlayerMatch) {
                    const ytData = JSON.parse(ytPlayerMatch[1]);
                    ytDescription = ytData?.videoDetails?.shortDescription || ytData?.videoDetails?.description || '';
                }
            } catch (e) {
                // Игнорируем ошибки парсинга YouTube данных
            }
            
            const title = ogTitleMatch?.[1] || jsonLdData?.name || jsonLdData?.headline || titleMatch?.[1] || '';
            // Пробуем все возможные источники описания
            const description = ogDescMatch?.[1] || 
                               metaDescMatch?.[1] || 
                               itemDescMatch?.[1] || 
                               jsonLdDescription || 
                               ytDescription || 
                               '';
            
            // Для YouTube также пробуем извлечь информацию о канале
            let channelInfo = '';
            if (url.includes('youtube.com') || url.includes('youtu.be')) {
                const channelMatch = html.match(/<link\s+itemprop=["']name["']\s+content=["']([^"']+)["']/i);
                const channelMatch2 = html.match(/<meta\s+itemprop=["']channelId["']\s+content=["']([^"']+)["']/i);
                if (channelMatch || channelMatch2) {
                    channelInfo = `\n\nКанал: ${channelMatch?.[1] || 'YouTube'}`;
                }
            }
            
            if (title || description) {
                const contentParts: string[] = [];
                if (title) contentParts.push(`Название: ${title}`);
                if (description) contentParts.push(`\n\nОписание: ${description}`);
                if (channelInfo) contentParts.push(channelInfo);
                
                const content = contentParts.join('') + 
                    '\n\n⚠️ ВАЖНО: Это только базовые метаданные (og:tags и JSON-LD). Полная расшифровка видео недоступна. Анализ проводится ТОЛЬКО на основе этих метаданных, без доступа к полному содержанию видео.';
                
                console.log(`✓ Extracted basic metadata via HTTP (title: ${title ? 'yes' : 'no'}, desc: ${description ? 'yes' : 'no'}, jsonLd: ${jsonLdData ? 'yes' : 'no'})`);
                return { content, sourceType: 'metadata' };
            }
        } catch (httpError: any) {
            if (httpError.name === 'AbortError') {
                console.warn(`⚠️ HTTP metadata extraction timed out after 15 seconds`);
            } else {
                console.warn(`⚠️ HTTP metadata extraction failed: ${httpError.message}`);
            }
            console.log(`   Trying Puppeteer fallback with shorter timeout...`);
        }
        
        // Fallback на Puppeteer с коротким таймаутом (если HTTP не сработал)
        let browser = null;
        try {
            console.log(`Extracting basic metadata via Puppeteer from: ${url}`);
            const launchOptions = await this.getPuppeteerLaunchOptions();
            browser = await puppeteer.launch(launchOptions);
            const page = await browser.newPage();
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
            });

            // Используем увеличенный таймаут для Railway/Docker (страницы грузятся медленно)
            await page.goto(url, { 
                waitUntil: 'domcontentloaded',
                timeout: 60000 // 60 секунд для контейнеров
            });
            
            // Ждем загрузки метаданных
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Извлекаем метаданные с множественными fallback селекторами
            const metadata = await page.evaluate(() => {
                const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
                const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
                const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
                const itemDesc = document.querySelector('meta[itemprop="description"]')?.getAttribute('content') || '';
                const title = document.querySelector('title')?.textContent || '';
                
                // Для YouTube также пробуем извлечь описание из ytInitialPlayerResponse
                let ytDescription = '';
                try {
                    const scripts = Array.from(document.querySelectorAll('script'));
                    for (const script of scripts) {
                        const text = script.textContent || '';
                        if (text.includes('ytInitialPlayerResponse')) {
                            const match = text.match(/var\s+ytInitialPlayerResponse\s*=\s*({[\s\S]*?});/);
                            if (match) {
                                const ytData = JSON.parse(match[1]);
                                ytDescription = ytData?.videoDetails?.shortDescription || ytData?.videoDetails?.description || '';
                                break;
                            }
                        }
                    }
                } catch (e) {
                    // Игнорируем ошибки
                }
                
                // Для YouTube также пробуем извлечь информацию о канале
                let channelName = '';
                const channelLink = document.querySelector('link[itemprop="name"]')?.getAttribute('content');
                const channelMeta = document.querySelector('meta[itemprop="channelId"]')?.getAttribute('content');
                if (channelLink) {
                    channelName = channelLink;
                } else if (channelMeta) {
                    channelName = 'YouTube';
                }
                
                return {
                    title: ogTitle || title,
                    description: ogDescription || metaDesc || itemDesc || ytDescription,
                    channelName
                };
            });

            if (metadata.title || metadata.description) {
                const contentParts: string[] = [];
                if (metadata.title) contentParts.push(`Название: ${metadata.title}`);
                if (metadata.description) contentParts.push(`\n\nОписание: ${metadata.description}`);
                if (metadata.channelName) contentParts.push(`\n\nКанал: ${metadata.channelName}`);

                const content = contentParts.join('') + 
                    '\n\n⚠️ ВАЖНО: Это только базовые метаданные (og:tags). Полная расшифровка видео недоступна. Анализ проводится ТОЛЬКО на основе этих метаданных, без доступа к полному содержанию видео.';

                console.log(`✓ Extracted basic metadata via Puppeteer (title: ${metadata.title ? 'yes' : 'no'}, desc: ${metadata.description ? 'yes' : 'no'})`);
                return { content, sourceType: 'metadata' };
            }

            return null;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            // Если это таймаут, не логируем как критическую ошибку
            if (errorMessage.includes('timeout') || errorMessage.includes('Navigation timeout')) {
                console.warn(`⚠️ Puppeteer metadata extraction timed out (expected for slow pages)`);
            } else {
                console.warn(`⚠️ Puppeteer metadata extraction failed: ${errorMessage}`);
            }
            return null;
        } finally {
            if (browser) {
                try {
                    await browser.close();
                } catch (e) {
                    // Игнорируем ошибки закрытия браузера
                }
            }
        }
    }

    isYoutubePlaylistUrl(url: string): boolean {
        const playlistPattern = /^https?:\/\/(www\.)?youtube\.com\/(playlist|watch).*list=([^&\n?#]+)/;
        return playlistPattern.test(url);
    }

    async extractVideoUrlsFromPlaylist(playlistUrl: string): Promise<string[]> {
        try {
            const playlist = await play.playlist_info(playlistUrl, { incomplete: true });
            const videos = await playlist.all_videos();
            return videos.map(video => video.url).filter(Boolean);
        } catch (error: any) {
            console.error(`Failed to extract videos from playlist: ${playlistUrl}`, error);
            throw new Error(`Failed to extract videos from playlist: ${error.message}`);
        }
    }

    /**
     * Основной метод для транскрибации видео
     * Поддерживает внешние API (Teamlogs, Audio-Transcription.ru и др.) и локальную транскрибацию как fallback
     */
    private async transcribeVideo(url: string, platform: string): Promise<string> {
        // Приоритет 1: Внешние API для транскрибации (быстро и надежно)
        
        // Teamlogs API (Российский сервис)
        if (process.env.TEAMLOGS_API_KEY) {
            try {
                console.log(`🌐 Using Teamlogs API for transcription...`);
                const response = await fetch(`https://api.teamlogs.ru/v1/transcribe`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.TEAMLOGS_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ url, language: 'ru' })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.text && data.text.trim().length > 50) {
                        console.log(`✓ Got transcript from Teamlogs API (${data.text.length} chars)`);
                        return data.text;
                    }
                }
            } catch (error: any) {
                console.warn(`⚠️ Teamlogs API failed: ${error.message}. Falling back...`);
            }
        }
        
        // Audio-Transcription.ru API (Российский сервис)
        if (process.env.AUDIO_TRANSCRIPTION_API_KEY) {
            try {
                console.log(`🌐 Using Audio-Transcription.ru API for transcription...`);
                const response = await fetch(`https://api.audio-transcription.ru/v1/transcribe`, {
                    method: 'POST',
                    headers: {
                        'X-API-Key': process.env.AUDIO_TRANSCRIPTION_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ url, language: 'ru' })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.text && data.text.trim().length > 50) {
                        console.log(`✓ Got transcript from Audio-Transcription.ru API (${data.text.length} chars)`);
                        return data.text;
                    }
                }
            } catch (error: any) {
                console.warn(`⚠️ Audio-Transcription.ru API failed: ${error.message}. Falling back...`);
            }
        }
        
        // Универсальный API ключ (если используется другой сервис)
        if (process.env.TRANSCRIPTION_API_KEY && process.env.TRANSCRIPTION_API_URL) {
            try {
                console.log(`🌐 Using custom transcription API...`);
                const response = await fetch(process.env.TRANSCRIPTION_API_URL, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.TRANSCRIPTION_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ url, platform, language: 'ru' })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.text && data.text.trim().length > 50) {
                        console.log(`✓ Got transcript from custom API (${data.text.length} chars)`);
                        return data.text;
                    }
                }
            } catch (error: any) {
                console.warn(`⚠️ Custom transcription API failed: ${error.message}. Falling back...`);
            }
        }
        
        // Приоритет 2: Локальная транскрибация (скачивание + Whisper)
        const tempDir = path.join(os.tmpdir(), 'video-transcription');
        await fs.ensureDir(tempDir);
        
        const videoId = this.extractVideoId(url, platform);
        const videoPath = path.join(tempDir, `${videoId}.mp4`);
        const audioPath = path.join(tempDir, `${videoId}.wav`);

        try {
            // Шаг 1: Скачиваем видео
            console.log(`📥 Downloading video from ${platform}...`);
            await this.downloadVideo(url, videoPath, platform);
            
            // Шаг 2: Извлекаем аудио
            console.log(`🎵 Extracting audio from video...`);
            await this.extractAudioFromVideo(videoPath, audioPath);
            
            // Шаг 3: Транскрибируем аудио
            console.log(`🎤 Transcribing audio...`);
            const transcript = await this.transcribeAudio(audioPath);
            
            return this.normalizeTranscript(transcript);
        } catch (error: any) {
            const errorMsg = error.message || 'Unknown error';
            console.error(`✗ Transcription failed for ${platform}: ${errorMsg}`);
            console.error(`   Full error:`, error);
            // Пробрасываем ошибку дальше, чтобы система могла использовать метаданные
            throw error;
        } finally {
            // Очищаем временные файлы
            try {
                if (await fs.pathExists(videoPath)) await fs.remove(videoPath);
                if (await fs.pathExists(audioPath)) await fs.remove(audioPath);
            } catch (cleanupError) {
                console.warn('Failed to cleanup temp files:', cleanupError);
            }
        }
    }

    /**
     * Извлекает ID видео из URL
     */
    private extractVideoId(url: string, platform: string): string {
        const patterns: { [key: string]: RegExp | RegExp[] } = {
            youtube: /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&\n?#]+)/,
            vk: [
                /vk\.com\/video(-?\d+_\d+)/,
                /vkvideo\.ru\/video(-?\d+_\d+)/,
                /vkontakte\.ru\/video(-?\d+_\d+)/,
            ],
            rutube: /rutube\.ru\/video\/([a-zA-Z0-9]+)/,
            tiktok: /tiktok\.com\/.+\/video\/(\d+)/,
            dzen: [
                /dzen\.ru\/video\/watch\/([a-zA-Z0-9]+)/,
                /dzen\.ru\/video\/([a-zA-Z0-9]+)/,
            ],
            instagram: /instagram\.com\/(?:reel|p)\/([a-zA-Z0-9_-]+)/,
            twitter: /(?:twitter\.com|x\.com)\/.+\/status\/(\d+)/,
        };

        const pattern = patterns[platform];
        if (pattern) {
            if (Array.isArray(pattern)) {
                // Для VK пробуем все паттерны
                for (const p of pattern) {
                    const match = url.match(p);
                    if (match && match[1]) {
                        return match[1].replace(/[^a-zA-Z0-9]/g, '_');
                    }
                }
            } else {
                const match = url.match(pattern);
                if (match && match[1]) {
                    return match[1].replace(/[^a-zA-Z0-9]/g, '_');
                }
            }
        }

        // Fallback: используем хеш URL
        return Buffer.from(url).toString('base64').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
    }

    /**
     * Скачивает видео с платформы
     */
    private async downloadVideo(url: string, outputPath: string, platform: string): Promise<void> {
        try {
            console.log(`📥 Downloading video from ${platform}...`);
            
            // 1. Быстрая попытка через play-dl
            try {
                const stream = await play.stream(url, { quality: 2 });
                const writeStream = fs.createWriteStream(outputPath);
                
                await new Promise<void>((resolve, reject) => {
                    stream.stream.pipe(writeStream);
                    writeStream.on('finish', () => {
                        console.log('✓ Video downloaded via play-dl');
                        resolve();
                    });
                    writeStream.on('error', (err: Error) => {
                        console.error('✗ Video download failed (play-dl stream error):', err);
                        reject(err);
                    });
                });
                return;
            } catch (playDlError: any) {
                console.warn(`play-dl failed for ${platform}: ${playDlError?.message || playDlError}. Falling back to yt-dlp...`);
            }
            
            // 2. Надёжный fallback — yt-dlp (поддерживает RuTube, YouTube и др.)
            await this.downloadWithYtDlp(url, outputPath);
        } catch (error: any) {
            throw new Error(`Failed to download video from ${platform}: ${error.message}`);
        }
    }

    private async downloadWithYtDlp(url: string, outputPath: string): Promise<void> {
        console.log('🎞️ Using yt-dlp fallback to download video...');
        try {
            // @ts-ignore - yt-dlp-exec types may not be available
            const ytdlp = (await import('yt-dlp-exec')).default;
            const normalizedOutput = outputPath.endsWith('.mp4') ? outputPath : `${outputPath}.mp4`;

            // Специальные опции для VK и других платформ, которые могут требовать авторизацию
            const options: any = {
                output: normalizedOutput,
                format: 'bestvideo*+bestaudio/best',
                mergeOutputFormat: 'mp4',
                quiet: true,
                restrictFilenames: true,
                noWarnings: true,
            };

            // Для VK добавляем дополнительные опции
            if (url.includes('vk.com') || url.includes('vkvideo.ru') || url.includes('vkontakte.ru')) {
                // Пробуем скачать без авторизации, если не получится - будет ошибка
                options.extractorArgs = {
                    vk: ['--no-check-certificate']
                };
            }

            await ytdlp(url, options);

            // Проверяем, что файл действительно скачался
            if (!(await fs.pathExists(normalizedOutput))) {
                throw new Error('Video file was not created after download');
            }

            const stats = await fs.stat(normalizedOutput);
            if (stats.size === 0) {
                throw new Error('Downloaded video file is empty');
            }

            console.log(`✓ Video downloaded via yt-dlp (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        } catch (error: any) {
            const errorMsg = error.message || 'Unknown error';
            console.error(`✗ yt-dlp download failed: ${errorMsg}`);
            
            // Более информативное сообщение об ошибке
            if (errorMsg.includes('Private video') || errorMsg.includes('Sign in')) {
                throw new Error('Video is private or requires authentication. Cannot download.');
            } else if (errorMsg.includes('Unsupported URL') || errorMsg.includes('No video formats')) {
                throw new Error('Video format not supported or video is unavailable.');
            } else {
                throw new Error(`yt-dlp failed: ${errorMsg}`);
            }
        }
    }

    /**
     * Извлекает аудио из видео файла
     */
    private async extractAudioFromVideo(videoPath: string, audioPath: string): Promise<void> {
        return new Promise(async (resolve, reject) => {
            try {
                // @ts-ignore - fluent-ffmpeg types may not be available
                const ffmpeg = await import('fluent-ffmpeg');
                // @ts-ignore - @ffmpeg-installer/ffmpeg types may not be available
                const ffmpegInstaller = await import('@ffmpeg-installer/ffmpeg');
                
                // Set ffmpeg path if available
                if (ffmpegInstaller.default?.path) {
                    ffmpeg.default.setFfmpegPath(ffmpegInstaller.default.path);
                }
                
                ffmpeg.default(videoPath)
                    .outputOptions([
                        '-vn', // No video
                        '-acodec', 'pcm_s16le', // PCM 16-bit
                        '-ar', '16000', // Sample rate 16kHz (оптимально для Whisper)
                        '-ac', '1' // Mono
                    ])
                    .output(audioPath)
                    .on('end', () => {
                        console.log('✓ Audio extracted successfully');
                        resolve();
                    })
                    .on('error', (err: any) => {
                        console.error('✗ Audio extraction failed:', err);
                        reject(err);
                    })
                    .run();
            } catch (error: any) {
                reject(new Error(`Failed to extract audio: ${error.message}`));
            }
        });
    }

    /**
     * Транскрибирует аудио файл в текст
     */
    private async transcribeAudio(audioPath: string): Promise<string> {
        // Приоритет: OpenAI Whisper API (если доступен), затем локальный Whisper
        if (process.env.OPENAI_API_KEY) {
            try {
                console.log('Using OpenAI Whisper API for transcription...');
                const OpenAI = (await import('openai')).default;
                const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                const fileStream = fs.createReadStream(audioPath);
                const transcription = await openai.audio.transcriptions.create({
                    file: fileStream as any,
                    model: 'whisper-1',
                    language: 'ru',
                });
                const text = transcription.text || '';
                return this.normalizeTranscript(text);
            } catch (error: any) {
                console.warn(`OpenAI Whisper API failed: ${error.message}, falling back to local Whisper...`);
            }
        }

        // Fallback: локальный Whisper через @xenova/transformers
        try {
            console.log('Using local Whisper model for transcription (this may take a while)...');
            // @ts-ignore - @xenova/transformers types may not be available
            const { pipeline } = await import('@xenova/transformers');
            // @ts-ignore - wav-decoder types may not be available
            const wavDecoder = await import('wav-decoder');

            // Загружаем wav-файл и преобразуем в Float32Array,
            // поскольку в Node.js нет AudioContext
            const audioBuffer = await fs.readFile(audioPath);
            const arrayBuffer = audioBuffer.buffer.slice(
                audioBuffer.byteOffset,
                audioBuffer.byteOffset + audioBuffer.byteLength
            );
            const decodedWav = await wavDecoder.decode(arrayBuffer);
            const channelData = decodedWav.channelData?.[0];

            if (!channelData) {
                throw new Error('Decoded audio has no channel data');
            }

            const transcriber = await pipeline(
                'automatic-speech-recognition',
                'Xenova/whisper-small',
                // @ts-ignore - device option is supported at runtime
                { device: 'cpu' }
            );

            const result = await transcriber(channelData, {
                language: 'russian',
                task: 'transcribe',
                // @ts-ignore - sampling_rate is supported at runtime
                sampling_rate: decodedWav.sampleRate,
            } as any);

            const text = (result as any).text || '';
            return this.normalizeTranscript(text);
        } catch (error: any) {
            throw new Error(`Transcription failed: ${error.message}`);
        }
    }

    /**
     * Получает последние N твитов из профиля Twitter/X (аналог getChannelPosts для Telegram).
     * Сначала пробует ScrapingBee (HTML профиля), затем Nitter (если есть), затем Puppeteer.
     */
    async getTwitterProfilePosts(username: string, limit: number = 6): Promise<Array<{ url: string; text?: string }>> {
        const cleanUsername = username.replace('@', '').trim();
        if (!cleanUsername) return [];

        const reservedPaths = new Set(['i', 'home', 'explore', 'search', 'intent', 'share', 'compose', 'settings', 'account', 'messages', 'notifications', 'login', 'signup']);
        if (reservedPaths.has(cleanUsername.toLowerCase())) return [];

        const profileUrl = `https://x.com/${cleanUsername}`;
        const results: Array<{ url: string; text?: string }> = [];
        const seenIds = new Set<string>();

        const addFromIds = (ids: string[]) => {
            for (const id of ids) {
                if (results.length >= limit || seenIds.has(id)) continue;
                seenIds.add(id);
                results.push({ url: `https://x.com/${cleanUsername}/status/${id}`, text: undefined });
            }
        };

        // Метод 1: ScrapingBee (только если задан ключ — бесплатного тира нет)
        if (process.env.SCRAPINGBEE_API_KEY || process.env.SCRAPINGBEE_API_KEYS) {
            try {
                const html = await this.extractWithScrapingBee(profileUrl);
                if (html) {
                    const cheerio = await import('cheerio');
                    const $ = cheerio.load(html);
                    const ids: string[] = [];
                    $('a[href*="/status/"]').each((_, el) => {
                        const href = $(el).attr('href') || '';
                        const match = href.match(/\/status\/(\d+)/);
                        if (match) ids.push(match[1]);
                    });
                    const uniqueIds = Array.from(new Set(ids));
                    addFromIds(uniqueIds);
                    if (results.length >= limit) {
                        console.log(`✓ [Twitter/X] Fetched ${results.length} tweet URLs from @${cleanUsername} via ScrapingBee`);
                        return results.slice(0, limit);
                    }
                    if (results.length > 0) {
                        console.log(`✓ [Twitter/X] Fetched ${results.length} tweet URLs from @${cleanUsername} via ScrapingBee (partial)`);
                        return results;
                    }
                }
            } catch (e: any) {
                console.log(`⚠️ [Twitter/X] ScrapingBee for profile failed: ${e?.message || e}`);
            }
        }

        // Метод 2: Nitter — простой HTML без тяжёлого JS (публичные инстансы могут быть нестабильны)
        const nitterInstances = ['https://nitter.net', 'https://nitter.poast.org'];
        for (const base of nitterInstances) {
            try {
                const nitterUrl = `${base}/${cleanUsername}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 12000);
                const res = await fetch(nitterUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const html = await res.text();
                const cheerio = await import('cheerio');
                const $ = cheerio.load(html);
                const ids: string[] = [];
                $('a[href*="/status/"]').each((_, el) => {
                    const href = $(el).attr('href') || '';
                    const match = href.match(/\/status\/(\d+)/);
                    if (match) ids.push(match[1]);
                });
                const uniqueIds = Array.from(new Set(ids));
                addFromIds(uniqueIds);
                if (results.length > 0) {
                    console.log(`✓ [Twitter/X] Fetched ${results.length} tweet URLs from @${cleanUsername} via Nitter (${base})`);
                    return results.slice(0, limit);
                }
            }
        } catch (e: any) {
            console.log(`⚠️ [Twitter/X] Nitter (${base}) failed: ${e?.message || e}`);
        }
        }

        // Метод 3: Puppeteer — полная загрузка ленты (с таймаутом, чтобы не зависать)
        const PUPPETEER_PROFILE_TIMEOUT_MS = 95000; // 95 сек — при нескольких профилях подряд первый Chrome может ещё закрываться
        try {
            // Пауза перед запуском — даёт предыдущему браузеру время закрыться при обработке нескольких профилей подряд
            await new Promise(resolve => setTimeout(resolve, 5000));
            console.log(`🐦 [Twitter/X] Fetching last ${limit} tweets from @${cleanUsername} via Puppeteer (timeout ${PUPPETEER_PROFILE_TIMEOUT_MS / 1000}s)...`);
            const puppeteerTask = (async () => {
                const launchOptions = await this.getPuppeteerLaunchOptions();
                const browser = await puppeteer.launch(launchOptions);
                try {
                    const page = await browser.newPage();
                    await page.setDefaultTimeout(20000);
                    await page.setViewport({ width: 1280, height: 800 });
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
                    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                    await new Promise(resolve => setTimeout(resolve, 10000));

                    try {
                        await page.waitForSelector('a[href*="/status/"]', { timeout: 15000 }).catch(() => null);
                    } catch (_) {}
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    for (let s = 0; s < 3; s++) {
                        await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                    const tweetData = await page.evaluate((uname: string) => {
                        const items: Array<{ id: string; text: string }> = [];
                        const seen = new Set<string>();
                        const selectors = [`a[href*="/${uname}/status/"]`, 'a[href*="/status/"]', 'article a[href*="status"]'];
                        const links = document.querySelectorAll(selectors.join(', '));
                        for (const a of Array.from(links)) {
                            const href = a.getAttribute('href') || '';
                            const match = href.match(/\/status\/(\d+)/);
                            if (match && !seen.has(match[1])) {
                                seen.add(match[1]);
                                const tweetEl = a.closest('article');
                                const textEl = tweetEl?.querySelector('[data-testid="tweetText"]');
                                const text = (textEl?.textContent?.trim() || '').slice(0, 500);
                                items.push({ id: match[1], text });
                            }
                        }
                        return { items, linkCount: links.length };
                    }, cleanUsername);

                    const items = tweetData?.items || [];
                    for (const item of items) {
                        if (results.length >= limit) break;
                        if (seenIds.has(item.id)) continue;
                        seenIds.add(item.id);
                        results.push({ url: `https://x.com/${cleanUsername}/status/${item.id}`, text: item.text || undefined });
                    }

                    if (results.length === 0 && tweetData?.linkCount !== undefined) {
                        console.log(`⚠️ [Twitter/X] Puppeteer found ${tweetData.linkCount} links for @${cleanUsername}, 0 tweet IDs (page may show "Something went wrong")`);
                    }
                    console.log(`✓ [Twitter/X] Fetched ${results.length} tweet URLs from @${cleanUsername} (Puppeteer)`);
                } finally {
                    await browser.close().catch(() => {});
                }
            })();

            await Promise.race([
                puppeteerTask,
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('Puppeteer timeout: X.com took too long to load')), PUPPETEER_PROFILE_TIMEOUT_MS)
                )
            ]);
        } catch (error: any) {
            console.warn(`⚠️ [Twitter/X] Failed to fetch profile @${cleanUsername}: ${error.message}`);
        }
        return results.slice(0, limit);
    }
}

export default new ContentService();
