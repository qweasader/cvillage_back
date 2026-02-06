// index.js — исправленная версия с правильной обработкой запросов и автоматической регистрацией
import { Telegraf } from 'telegraf';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { QuestDatabase } from './database.js';
import 'dotenv/config';

// ==================== КОНФИГУРАЦИЯ ====================
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL;
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PUBLIC_DIR = path.join(process.cwd(), 'public');

if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не установлен');
if (ADMIN_USER_IDS[0] === 123456789) throw new Error('Замените 123456789 на ваш реальный Telegram ID');

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
const db = new QuestDatabase();
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

const sessions = new Map();
function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, {});
  return sessions.get(userId);
}

// ==================== ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ: БЕЗОПАСНОЕ РЕДАКТИРОВАНИЕ СООБЩЕНИЯ ====================
async function safeEditMessage(ctx, text, extra = {}) {
  try {
    // Проверяем, есть ли у контекста сообщение для редактирования
    if (!ctx.callbackQuery?.message) {
      console.warn('⚠️ Невозможно отредактировать сообщение: нет сообщения в контексте');
      await ctx.answerCbQuery();
      return;
    }
    
    // Получаем текущее содержимое сообщения
    const currentText = ctx.callbackQuery.message.text || ctx.callbackQuery.message.caption || '';
    const currentMarkup = JSON.stringify(ctx.callbackQuery.message.reply_markup || {});
    const newText = text;
    const newMarkup = JSON.stringify(extra.reply_markup || {});
    
    // Если содержимое не изменилось — просто отвечаем на колбэк без редактирования
    if (currentText === newText && currentMarkup === newMarkup) {
      console.log('ℹ️ Пропуск редактирования: содержимое сообщения не изменилось');
      await ctx.answerCbQuery();
      return;
    }
    
    // Безопасное редактирование с обработкой ошибки "message is not modified"
    await ctx.editMessageText(text, extra);
    await ctx.answerCbQuery();
    
  } catch (error) {
    // Обработка специфической ошибки Telegram
    if (error?.response?.description?.includes('message is not modified')) {
      console.log('ℹ️ Пропущена ошибка "message is not modified" — содержимое не изменилось');
      await ctx.answerCbQuery();
      return;
    }
    
    // Обработка ошибки "message to edit not found" (сообщение уже удалено)
    if (error?.response?.description?.includes('message to edit not found')) {
      console.warn('⚠️ Сообщение уже удалено, невозможно отредактировать');
      await ctx.answerCbQuery('Сообщение уже закрыто', { show_alert: true });
      return;
    }
    
    // Другие ошибки — пробрасываем выше для глобального обработчика
    throw error;
  }
}

// ==================== HTTP СЕРВЕР С ПОЛНЫМ ЛОГИРОВАНИЕМ ====================
const server = http.createServer(async (req, res) => {
  // Устанавливаем заголовки CORS ДЛЯ ВСЕХ ответов
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data, X-Telegram-InitData');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  // Обработка preflight запросов
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // ============ 1. ВЕБХУКИ TELEGRAM (POST) ============
  if (pathname === `/${WEBHOOK_SECRET}` && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        bot.handleUpdate(update, res);
      } catch (error) {
        console.error('❌ Ошибка вебхука:', error);
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });
    return;
  }

  // ============ 2. HEALTH CHECK (GET) ============
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      sqlite_busy_timeout: 30000,
      sqlite_journal_mode: 'WAL',
      routes: {
        static: '/ (index.html, *.js, *.css)',
        api: '/check-password, /get-mission, /check-answer, /request-hint'
      }
    }));
    return;
  }

  // ============ 3. СТАТИЧЕСКИЕ ФАЙЛЫ (ТОЛЬКО GET) ============
  if (req.method === 'GET') {
    // Защита от обхода каталогов
    if (pathname.includes('..') || pathname.includes('%')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }

    // Определяем путь к файлу
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    
    // Если это директория — отдаём index.html
    try {
      if (fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
    } catch (e) {
      // Файл не существует — пробуем добавить .html
      if (!path.extname(filePath)) {
        const htmlPath = filePath + '.html';
        if (fs.existsSync(htmlPath)) {
          filePath = htmlPath;
        } else {
          // Для неизвестных маршрутов отдаём главную страницу (SPA)
          filePath = path.join(PUBLIC_DIR, 'index.html');
        }
      }
    }

    // Проверяем существование файла
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️ Файл не найден: ${filePath}`);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    // Определяем тип содержимого
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'application/font-woff',
      '.woff2': 'application/font-woff2',
      '.ttf': 'application/font-ttf',
      '.eot': 'application/vnd.ms-fontobject',
      '.otf': 'application/font-otf'
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    // Читаем и отправляем файл
    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
      console.log(`✅ Отправлен статический файл: ${pathname} (${content.length} байт)`);
      return;
    } catch (error) {
      console.error(`❌ Ошибка чтения файла ${filePath}:`, error.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
      return;
    }
  }

  // ============ 4. API-ЗАПРОСЫ (ТОЛЬКО POST) ============
  let userId = null;
  let initData = req.headers['x-telegram-init-data'] || req.headers['x-telegram-initdata'] || '';
  
  // Дополнительная проверка для случаев, когда initData передаётся в другом регистре
  if (!initData) {
    Object.keys(req.headers).forEach(key => {
      if (key.toLowerCase().includes('telegram-init')) {
        initData = req.headers[key];
      }
    });
  }
  
  console.log(`\n🔐 API-запрос: ${req.method} ${pathname}`);
  console.log(`   User-Agent: ${req.headers['user-agent']?.substring(0, 50) || 'не указан'}`);
  console.log(`   Заголовок initData: ${initData ? 'ПРИСУТСТВУЕТ (длина ' + initData.length + ')' : 'ОТСУТСТВУЕТ'}`);
  
  // Извлечение userId из initData
  if (initData) {
    try {
      const params = new URLSearchParams(initData);
      const userParam = params.get('user');
      
      if (userParam) {
        const userObj = JSON.parse(decodeURIComponent(userParam));
        userId = String(userObj.id);
        console.log(`   ✅ Извлечён userId: ${userId} (${userObj.first_name} ${userObj.last_name || ''})`);
      } else {
        console.warn('   ⚠️ Параметр "user" не найден в initData');
      }
    } catch (e) {
      console.error('   ❌ Ошибка парсинга initData:', e.message);
      console.error('   initData (первые 200 символов):', initData.substring(0, 200));
    }
  }

  // КРИТИЧЕСКАЯ ПРОВЕРКА: если нет userId — ошибка авторизации
  if (!userId) {
    console.error('   ❌ КРИТИЧЕСКАЯ ОШИБКА: Не удалось извлечь userId из initData');
    console.error('   Все заголовки с "telegram":');
    Object.keys(req.headers)
      .filter(h => h.toLowerCase().includes('telegram'))
      .forEach(h => console.error(`      ${h}: ${req.headers[h]?.substring(0, 100)}`));
    
    res.writeHead(401, { 
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ 
      success: false, 
      message: 'Не авторизован. Откройте приложение через кнопку в боте!',
      error_code: 'MISSING_USER_ID',
      debug: {
        initDataPresent: !!initData,
        initDataLength: initData.length,
        headersReceived: Object.keys(req.headers).filter(h => h.toLowerCase().includes('telegram'))
      }
    }));
    return;
  }

  // ============ АВТОМАТИЧЕСКАЯ РЕГИСТРАЦИЯ ИГРОКА ============
  let player = null;
  try {
    player = db.getPlayer(userId);
    
    if (!player || !player.is_registered) {
      console.log(`   ℹ️ Игрок ${userId} не зарегистрирован или не активен — запускаем автоматическую регистрацию...`);
      
      // Автоматическая регистрация при первом запросе
      const { player: newPlayer, team } = db.createTeamForPlayer(
        userId, 
        `Игрок ${userId.substring(0, 6)}`
      );
      
      player = newPlayer;
      console.log(`   ✅ Автоматическая регистрация игрока ${userId} завершена`);
    } else {
      console.log(`   ✅ Игрок ${userId} найден в базе: ${player.first_name}`);
    }
  } catch (error) {
    console.error(`   ❌ ОШИБКА автоматической регистрации игрока ${userId}:`, error.message);
    res.writeHead(500, { 
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ 
      success: false, 
      message: 'Ошибка регистрации. Попробуйте обновить страницу или написать /start в боте.',
      error_code: 'REGISTRATION_FAILED',
      debug: { userId, error: error.message.substring(0, 100) }
    }));
    return;
  }

  // ============ ПОЛУЧЕНИЕ КОМАНДЫ ============
  let team = null;
  try {
    team = db.getTeamByPlayerId(userId);
    
    if (!team) {
      console.error(`   ❌ КРИТИЧЕСКАЯ ОШИБКА: команда не найдена для игрока ${userId} после регистрации`);
      res.writeHead(500, { 
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ 
        success: false, 
        message: 'Ошибка команды. Напишите /start в боте для повторной регистрации.',
        error_code: 'TEAM_NOT_FOUND',
        debug: { userId }
      }));
      return;
    }
    
    console.log(`   ✅ Команда найдена: ${team.name} (ID: ${team.id})`);
  } catch (error) {
    console.error(`   ❌ КРИТИЧЕСКАЯ ОШИБКА получения команды для игрока ${userId}:`, error.message);
    res.writeHead(500, { 
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ 
      success: false, 
      message: 'Ошибка базы данных. Попробуйте обновить страницу.',
      error_code: 'DB_TEAM_ERROR',
      debug: { userId }
    }));
    return;
  }

  // Определение текущей локации по маршруту
  const currentLocation = db.getCurrentLocationForTeam(team.id);
  const unlocked = JSON.parse(team.unlocked_locations || '["gates"]');
  
  console.log(`   📍 Текущая локация команды ${team.id}: "${currentLocation}"`);
  console.log(`   🔓 Разблокировано: ${unlocked.join(', ')}`);
  console.log(`   ✅ Все проверки пройдены — обработка запроса...`);

  // Парсинг тела запроса
  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', async () => {
    try {
      const data = body ? JSON.parse(body) : {};

      // ============ ПОЛУЧЕНИЕ ЗАДАНИЯ ============
      if (pathname === '/get-mission' && req.method === 'POST') {
        console.log(`\n📜 [get-mission] Запрос задания для локации "${currentLocation}" от игрока ${userId}`);
        
        if (!unlocked.includes(currentLocation)) {
          console.warn(`   ⚠️ Локация "${currentLocation}" не разблокирована для команды ${team.id}`);
          res.writeHead(403, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            error: 'access_denied',
            message: 'Сначала введите пароль доступа к локации' 
          }));
          return;
        }
        
        let mission = null;
        try {
          mission = db.getMission(currentLocation);
        } catch (error) {
          console.error(`   ❌ ОШИБКА получения задания для локации "${currentLocation}":`, error.message);
          res.writeHead(500, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            error: 'db_error',
            message: 'Ошибка базы данных. Попробуйте обновить страницу.',
            debug: { location: currentLocation, error: error.message.substring(0, 100) }
          }));
          return;
        }
        
        if (!mission) {
          console.warn(`   ⚠️ Задание для локации "${currentLocation}" не настроено`);
          res.writeHead(404, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            error: 'mission_not_found',
            message: 'Задание ещё не настроено администратором' 
          }));
          return;
        }
        
        // УСПЕШНЫЙ ОТВЕТ
        res.writeHead(200, { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ 
          success: true,
          location: currentLocation,
          locationName: db.locationGraph[currentLocation].name,
          locationEmoji: db.locationGraph[currentLocation].emoji,
          mission: {
            text: mission.text,
            imageUrl: mission.image_url
          },
          team: {
            id: team.id,
            name: team.name,
            completedLocations: JSON.parse(team.completed_locations || '[]').length,
            totalLocations: 6,
            hintsUsed: team.hints_used,
            hintsLeft: 3 - team.hints_used,
            route: JSON.parse(team.route)
          }
        }));
        
        console.log(`   ✅ Задание для локации "${currentLocation}" успешно отправлено`);
        return;
      }

      // ============ ПРОВЕРКА ПАРОЛЯ ============
      if (pathname === '/check-password' && req.method === 'POST') {
        const { password } = data;
        
        if (!password) {
          res.writeHead(400, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, message: 'Не указан пароль' }));
          return;
        }
        
        if (!unlocked.includes(currentLocation)) {
          res.writeHead(200, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Эта локация ещё недоступна. Завершите предыдущие задания!' 
          }));
          return;
        }
        
        const passwordData = db.getPassword(currentLocation);
        if (!passwordData) {
          res.writeHead(200, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Пароль для этой локации ещё не настроен администратором.'
          }));
          return;
        }
        
        const cleanInput = password.trim();
        const normalizedInput = db.normalizePassword(cleanInput);
        const isCorrect = normalizedInput === passwordData.normalized;
        
        console.log(`   🔑 Результат проверки пароля: ${isCorrect ? '✅ ВЕРНО' : '❌ НЕВЕРНО'}`);
        
        if (isCorrect) {
          db.logEvent('location_unlocked', team.id, currentLocation, { userId });
          res.writeHead(200, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: true, 
            message: 'Пароль верный! Задание открыто.',
            location: currentLocation,
            locationName: db.locationGraph[currentLocation].name,
            nextLocation: db.getNextLocationForTeam(team.id)
          }));
        } else {
          db.logEvent('wrong_password', team.id, currentLocation, { userId, input: cleanInput.substring(0, 20) });
          res.writeHead(200, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Неверный пароль! Проверьте написание и попробуйте снова.'
          }));
        }
        return;
      }

      // ============ ПРОВЕРКА ОТВЕТА ============
      if (pathname === '/check-answer' && req.method === 'POST') {
        const { answer } = data;
        
        if (!answer) {
          res.writeHead(400, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, message: 'Не указан ответ' }));
          return;
        }
        
        const mission = db.getMission(currentLocation);
        if (!mission) {
          res.writeHead(404, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, message: 'Задание не найдено' }));
          return;
        }
        
        if (!mission.normalized_answer || mission.normalized_answer.trim() === '') {
          console.error(`❌ КРИТИЧЕСКАЯ ОШИБКА: Для локации "${currentLocation}" не настроен нормализованный ответ!`);
          
          res.writeHead(500, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Задание настроено некорректно. Обратитесь к администратору квеста.',
            debug: {
              location: currentLocation,
              answerInDb: mission.answer,
              normalizedAnswerInDb: mission.normalized_answer
            }
          }));
          return;
        }
        
        const cleanInput = answer.trim();
        const normalizedInput = db.normalizeAnswer(cleanInput);
        const isCorrect = normalizedInput === mission.normalized_answer;
        
        if (isCorrect) {
          db.completeLocationForTeam(team.id, currentLocation);
          db.logEvent('location_completed', team.id, currentLocation, { userId });
          
          const updatedTeam = db.getTeamById(team.id);
          const completed = JSON.parse(updatedTeam.completed_locations || '[]');
          const isQuestComplete = completed.length >= 6;
          const nextLocation = db.getNextLocationForTeam(team.id);
          
          res.writeHead(200, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: true, 
            message: 'Верно! Локация пройдена!',
            nextLocation: nextLocation,
            nextLocationName: nextLocation ? db.locationGraph[nextLocation].name : null,
            questComplete: isQuestComplete,
            teamProgress: {
              completed: completed.length,
              total: 6
            }
          }));
        } else {
          db.logEvent('wrong_answer', team.id, currentLocation, { userId, input: answer.trim().substring(0, 20) });
          
          res.writeHead(200, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Неверный ответ! Обсудите с командой или запросите подсказку.',
            debug: {
              inputRaw: answer,
              inputNormalized: normalizedInput,
              expectedNormalized: mission.normalized_answer
            }
          }));
        }
        return;
      }

      // ============ ЗАПРОС ПОДСКАЗКИ ============
      if (pathname === '/request-hint' && req.method === 'POST') {
        const { hintLevel = 1 } = data;
        
        console.log(`\n💡 Запрос подсказки (уровень ${hintLevel}) для локации "${currentLocation}"`);
        
        if (team.hints_used >= 3) {
          res.writeHead(200, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false,
            error: 'no_hints_left',
            message: 'У вашей команды закончились подсказки!'
          }));
          return;
        }
        
        const hint = db.getHint(currentLocation, hintLevel);
        if (!hint) {
          res.writeHead(404, { 
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false,
            error: 'not_found',
            message: 'Подсказка не найдена' 
          }));
          return;
        }
        
        db.db.prepare('UPDATE teams SET hints_used = hints_used + 1, last_activity = CURRENT_TIMESTAMP WHERE id = ?')
          .run(team.id);
        
        db.logEvent('hint_used', team.id, currentLocation, { userId, level: hintLevel });
        
        const updatedTeam = db.getTeamById(team.id);
        
        res.writeHead(200, { 
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ 
          success: true,
          text: hint.text,
          hintsUsed: updatedTeam.hints_used,
          hintsLeft: 3 - updatedTeam.hints_used,
          location: currentLocation
        }));
        return;
      }

      // 404 для неизвестных эндпоинтов
      res.writeHead(404, { 
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ error: 'Not found' }));
      
    } catch (error) {
      console.error('❌ КРИТИЧЕСКАЯ ОШИБКА обработки API-запроса:', error);
      console.error('Стек:', error.stack);
      
      res.writeHead(500, { 
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ 
        error: 'internal_server_error',
        message: 'Ошибка сервера. Попробуйте обновить страницу.',
        debug: { 
          userId,
          pathname,
          error: error.message.substring(0, 200),
          timestamp: new Date().toISOString()
        }
      }));
    }
  });
});

// ==================== TELEGRAM БОТ — ПОЛНЫЙ КОД ====================
bot.use((ctx, next) => {
  ctx.isAdmin = ADMIN_USER_IDS.includes(ctx.from?.id);
  ctx.session = getSession(ctx.from?.id);
  return next();
});

bot.start(async (ctx) => {
  const player = db.getPlayer(ctx.from.id);
  const isRegistered = player && player.is_registered;
  
  if (isRegistered) {
    const team = db.getTeamByPlayerId(ctx.from.id);
    await ctx.replyWithHTML(
      `👋 <b>С возвращением, ${player.first_name}!</b>\n\n` +
      `🛡️ Ваша команда: <b>${team.name}</b>\n` +
      `🗺️ Уникальный маршрут: ${JSON.parse(team.route).map(loc => db.locationGraph[loc].emoji).join(' → ')}\n\n` +
      `<b>Выберите действие:</b>`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Начать квест', web_app: { url: `${FRONTEND_URL}` } }],
            [{ text: '📊 Статистика', callback_data:'team_stats' }]
          ]
        }
      }
    );
    return;
  }
  
  const { player: newPlayer, team } = db.createTeamForPlayer(
    ctx.from.id, 
    ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '')
  );
  
  await ctx.replyWithHTML(
    `✅ <b>Регистрация завершена!</b>\n\n` +
    `👤 <b>Игрок:</b> ${newPlayer.first_name}\n` +
    `🛡️ <b>Команда:</b> ${team.name}\n` +
    `🗺️ <b>Ваш уникальный маршрут:</b>\n` +
    `${JSON.parse(team.route).map((loc, i) => `${i + 1}. ${db.locationGraph[loc].emoji} ${db.locationGraph[loc].name}`).join('\n')}\n\n` +
    `✨ <b>Особенность вашего маршрута:</b>\n` +
    `Команды никогда не пересекутся на локациях!\n\n` +
    `Готовы спасти Кибердеревню?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Начать квест', web_app: { url: `${FRONTEND_URL}` } }],
          [{ text: '📊 Статистика', callback_data:'team_stats' }]
        ]
      }
    }
  );
});

bot.action('admin_panel', async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.answerCbQuery('Доступ запрещён', { show_alert: true });
    return;
  }
  await showAdminMenu(ctx, true);
});

bot.command('admin', async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.replyWithHTML(`🚫 <b>Доступ запрещён</b>\n\nВаш ID: <code>${ctx.from.id}</code>`);
    return;
  }
  await showAdminMenu(ctx, false);
});

bot.action('team_stats', async (ctx) => {
  const player = db.getPlayer(ctx.from.id);
  if (!player || !player.is_registered) {
    await ctx.answerCbQuery('Сначала зарегистрируйтесь!', { show_alert: true });
    return;
  }
  
  const team = db.getTeamByPlayerId(ctx.from.id);
  const completed = JSON.parse(team.completed_locations || '[]').length;
  const unlocked = JSON.parse(team.unlocked_locations || '["gates"]').length;
  const hintsLeft = 3 - team.hints_used;
  const route = JSON.parse(team.route);
  
  let routeText = route.map((loc, i) => {
    const isCompleted = i < completed;
    const isCurrent = i === completed;
    const marker = isCompleted ? '✅' : (isCurrent ? '➡️' : '🔲');
    return `${marker} ${i + 1}. ${db.locationGraph[loc].emoji} ${db.locationGraph[loc].name}`;
  }).join('\n');
  
  const message = `📊 <b>Статистика вашей команды</b>\n\n` +
    `🛡️ Название: ${team.name}\n` +
    `✅ Пройдено локаций: ${completed}/6\n` +
    `🔓 Открыто локаций: ${unlocked}/6\n` +
    `💡 Осталось подсказок: ${hintsLeft}/3\n\n` +
    `<b>Ваш маршрут:</b>\n${routeText}`;
  
  await safeEditMessage(ctx, message, { parse_mode: 'HTML' });
});

bot.command('stats', async (ctx) => {
  const player = await db.getPlayer(ctx.from.id);
  if (!player || !player.is_registered) {
    await ctx.reply('Сначала зарегистрируйтесь командой /start');
    return;
  }
  
  const team = db.getTeamByPlayerId(ctx.from.id);
  const completed = JSON.parse(team.completed_locations || '[]').length;
  const unlocked = JSON.parse(team.unlocked_locations || '["gates"]').length;
  const hintsLeft = 3 - team.hints_used;
  
  await ctx.replyWithHTML(
    `📊 <b>Ваша статистика</b>\n\n` +
    `👤 Игрок: ${player.first_name}\n` +
    `🛡️ Команда: ${team.name}\n` +
    `✅ Пройдено локаций: ${completed}/6\n` +
    `🔓 Открыто локаций: ${unlocked}/6\n` +
    `💡 Осталось подсказок: ${hintsLeft}/3`
  );
});

bot.command('hint', async (ctx) => {
  const player = await db.getPlayer(ctx.from.id);
  if (!player || !player.is_registered) {
    await ctx.reply('Сначала зарегистрируйтесь командой /start');
    return;
  }
  
  const team = db.getTeamByPlayerId(ctx.from.id);
  if (team.hints_used >= 3) {
    await ctx.reply('🚫 У вашей команды закончились подсказки!');
    return;
  }
  
  const completed = JSON.parse(team.completed_locations || '[]');
  const nextLocationIndex = completed.length;
  const currentLocation = Object.keys(db.locationGraph)[nextLocationIndex] || 'gates';
  
  const hintLevel = team.hints_used + 1;
  const hint = await db.getHint(currentLocation, hintLevel);
  
  if (!hint) {
    await ctx.reply('🤔 Подсказка для текущей локации не настроена.');
    return;
  }
  
  db.db.prepare('UPDATE teams SET hints_used = hints_used + 1, last_activity = CURRENT_TIMESTAMP WHERE id = ?')
    .run(team.id);
  
  await db.logEvent('hint_used', team.id, currentLocation, { userId: ctx.from.id, level: hintLevel });
  
  const hintsLeft = 3 - (team.hints_used + 1);
  
  await ctx.replyWithHTML(
    `💡 <b>Подсказка для "${db.locationGraph[currentLocation].name}"</b>\n\n` +
    `${hint.text}\n\n` +
    `Осталось подсказок: ${hintsLeft}/3`
  );
});

async function showAdminMenu(ctx, useEdit = true) {
  const pwdCount = db.getAllPasswords().length;
  const missionCount = db.getAllMissions().length;
  const hintCount = db.db.prepare('SELECT COUNT(*) as cnt FROM hints').get().cnt;
  
  const message = `🔧 <b>Админ-панель квеста</b>\n\n` +
    `✅ Паролей задано: ${pwdCount}/6\n` +
    `✅ Заданий настроено: ${missionCount}/6\n` +
    `✅ Подсказок создано: ${hintCount}\n\n` +
    `<b>Выберите раздел для управления:</b>`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔑 Пароли доступа', callback_data:'admin_passwords' }],
      [{ text: '📝 Задания локаций', callback_data:'admin_missions' }],
      [{ text: '💡 Подсказки', callback_data:'admin_hints' }],
      [{ text: '📊 Статистика', callback_data:'admin_stats' }]
    ]
  };
  
  if (useEdit && ctx.callbackQuery) {
    await safeEditMessage(ctx, message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } else {
    await ctx.reply(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }
}

bot.action('admin_passwords', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const passwords = db.getAllPasswords();
  
  let msg = `🔑 <b>Пароли доступа к локациям</b>\n\n` +
    `<i>Эти пароли игроки вводят для открытия задания на локации</i>\n\n`;
  
  Object.entries(db.locationGraph).forEach(([id, loc]) => {
    const pwd = passwords.find(p => p.location === id);
    msg += `${pwd ? '✅' : '❌'} ${loc.emoji} ${loc.name}: ` +
           `<code>${pwd?.password || 'не задан'}</code>\n`;
  });
  
  msg += `\n<b>Выберите локацию для настройки пароля:</b>`;
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🚪 Врата', callback_data:'set_pwd_gates' },
        { text: '🛡️ Купол', callback_data:'set_pwd_dome' }
      ],
      [
        { text: '🪞 Зеркало', callback_data:'set_pwd_mirror' },
        { text: '🔮 Камень', callback_data:'set_pwd_stone' }
      ],
      [
        { text: '🏠 Хижина', callback_data:'set_pwd_hut' },
        { text: '👾 Логово', callback_data:'set_pwd_lair' }
      ],
      [{ text: '🔙 Назад', callback_data:'admin_main' }]
    ]
  };
  
  await safeEditMessage(ctx, msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

bot.action(/set_pwd_(.+)/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  if (!db.locationGraph[locationId]) {
    await ctx.answerCbQuery('Локация не найдена', { show_alert: true });
    return;
  }
  
  ctx.session.settingType = 'password';
  ctx.session.location = locationId;
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🔑 <b>Установка пароля для "${db.locationGraph[locationId].name}"</b>\n\n` +
    `Отправьте пароль доступа к локации:\n` +
    `<i>• Регистр НЕ важен\n` +
    `• Без пробелов в начале/конце\n` +
    `• Пример: <code>gate2024</code></i>`
  );
});

bot.action('admin_missions', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const missions = db.getAllMissions();
  
  let msg = `📝 <b>Задания локаций</b>\n\n` +
    `<i>Эти задания игроки видят после ввода пароля доступа</i>\n\n`;
  
  Object.entries(db.locationGraph).forEach(([id, loc]) => {
    const mission = missions.find(m => m.location === id);
    msg += `${mission ? '✅' : '❌'} ${loc.emoji} ${loc.name}\n`;
  });
  
  msg += `\n<b>Выберите локацию для настройки задания:</b>`;
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🚪 Врата', callback_data:'set_mission_gates' },
        { text: '🛡️ Купол', callback_data:'set_mission_dome' }
      ],
      [
        { text: '🪞 Зеркало', callback_data:'set_mission_mirror' },
        { text: '🔮 Камень', callback_data:'set_mission_stone' }
      ],
      [
        { text: '🏠 Хижина', callback_data:'set_mission_hut' },
        { text: '👾 Логово', callback_data:'set_mission_lair' }
      ],
      [{ text: '🔙 Назад', callback_data:'admin_main' }]
    ]
  };
  
  await safeEditMessage(ctx, msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

bot.action(/set_mission_(.+)/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  if (!db.locationGraph[locationId]) {
    await ctx.answerCbQuery('Локация не найдена', { show_alert: true });
    return;
  }
  
  ctx.session.settingType = 'mission';
  ctx.session.location = locationId;
  ctx.session.step = 'text';
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `📝 <b>Настройка задания для "${db.locationGraph[locationId].name}"</b>\n\n` +
    `Шаг 1/3: Отправьте <b>текст задания</b>:\n` +
    `<i>Пример: "Найди амулет под древним дубом"</i>`
  );
});

bot.action('admin_hints', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const hintCounts = {};
  Object.keys(db.locationGraph).forEach(loc => {
    hintCounts[loc] = db.getHintsForLocation(loc).length;
  });
  
  let msg = `💡 <b>Подсказки по локациям</b>\n\n` +
    `<i>Игроки могут запросить до 3 подсказок за квест</i>\n\n`;
  
  Object.entries(db.locationGraph).forEach(([id, loc]) => {
    msg += `${loc.emoji} ${loc.name}: ${hintCounts[id]} подсказок\n`;
  });
  
  msg += `\n<b>Выберите действие:</b>`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '➕ Добавить подсказку', callback_data:'add_hint' }],
      [{ text: '🔙 Назад', callback_data:'admin_main' }]
    ]
  };
  
  await safeEditMessage(ctx, msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

bot.action('add_hint', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🚪 Врата', callback_data:'hint_loc_gates' },
        { text: '🛡️ Купол', callback_data:'hint_loc_dome' }
      ],
      [
        { text: '🪞 Зеркало', callback_data:'hint_loc_mirror' },
        { text: '🔮 Камень', callback_data:'hint_loc_stone' }
      ],
      [
        { text: '🏠 Хижина', callback_data:'hint_loc_hut' },
        { text: '👾 Логово', callback_data:'hint_loc_lair' }
      ],
      [{ text: '🔙 Отмена', callback_data:'admin_hints' }]
    ]
  };
  
  await ctx.replyWithHTML(
    `➕ <b>Добавление подсказки</b>\n\nВыберите локацию:`,
    { reply_markup: keyboard }
  );
  await ctx.answerCbQuery();
});

bot.action(/hint_loc_(.+)/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  if (!db.locationGraph[locationId]) {
    await ctx.answerCbQuery('Локация не найдена', { show_alert: true });
    return;
  }
  
  ctx.session.settingType = 'hint';
  ctx.session.location = locationId;
  ctx.session.step = 'level';
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🔢 <b>Уровень подсказки для "${db.locationGraph[locationId].name}"</b>\n\n` +
    `Отправьте уровень (1-3):\n` +
    `1️⃣ — Общая подсказка\n` +
    `2️⃣ — Конкретная подсказка\n` +
    `3️⃣ — Детальная подсказка`
  );
});

bot.action('admin_stats', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const { totalTeams, completedTeams, totalPlayers } = db.getStats();
  
  const msg = `📊 <b>Статистика квеста</b>\n\n` +
    `👥 Всего команд: ${totalTeams}\n` +
    `🏆 Завершили квест: ${completedTeams}\n` +
    `👤 Всего игроков: ${totalPlayers}\n\n` +
    `<i>Статистика обновляется в реальном времени</i>`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔄 Обновить', callback_data:'admin_stats' }],
      [{ text: '🔙 Назад', callback_data:'admin_main' }]
    ]
  };
  
  await safeEditMessage(ctx, msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

bot.action('admin_main', async (ctx) => {
  if (!ctx.isAdmin) return;
  await showAdminMenu(ctx, true);
});

bot.on('text', async (ctx) => {
  if (ctx.isAdmin && ctx.session?.settingType) {
    const { settingType, location, step } = ctx.session;
    const text = ctx.message.text.trim();
    
    if (settingType === 'password') {
      if (text.length < 4) {
        await ctx.reply('⚠️ Пароль должен быть не менее 4 символов. Попробуйте ещё раз:');
        return;
      }
      
      db.setPassword(location, text);
      await ctx.replyWithHTML(
        `✅ <b>Пароль установлен!</b>\n\n` +
        `Локация: ${db.locationGraph[location].name}\n` +
        `Пароль: <code>${text}</code>\n\n` +
        `<i>Игроки должны ввести этот пароль для доступа к заданию</i>`
      );
      
      delete ctx.session.settingType;
      delete ctx.session.location;
      await showAdminMenu(ctx, false);
      return;
    }
    
    if (settingType === 'mission' && step === 'text') {
      ctx.session.missionText = text;
      ctx.session.step = 'answer';
      await ctx.replyWithHTML(
        `📝 <b>Настройка задания для "${db.locationGraph[location].name}"</b>\n\n` +
        `Шаг 2/3: Отправьте <b>правильный ответ</b>:\n` +
        `<i>Пример: "дуб2024"</i>\n\n` +
        `<b>ВАЖНО:</b> Ответ не может быть "-" или пустым!`
      );
      return;
    }
    
    if (settingType === 'mission' && step === 'answer') {
      if (!text || text.trim() === '' || text.trim() === '-') {
        await ctx.replyWithHTML(
          `❌ <b>Ошибка!</b>\n\n` +
          `Ответ не может быть пустым или "-".\n\n` +
          `Пожалуйста, введите корректный ответ:`
        );
        return;
      }
      
      ctx.session.missionAnswer = text;
      ctx.session.step = 'image';
      await ctx.replyWithHTML(
        `📝 <b>Настройка задания для "${db.locationGraph[location].name}"</b>\n\n` +
        `Шаг 3/3: Отправьте <b>URL изображения</b> или "-" для пропуска:\n` +
        `<i>Рекомендуется: 800x600px, JPG/PNG</i>`
      );
      return;
    }
    
    if (settingType === 'mission' && step === 'image') {
      const imageUrl = (text && text.trim() !== '-') ? text.trim() : null;
      
      try {
        db.setMission(location, ctx.session.missionText, ctx.session.missionAnswer, imageUrl);
        
        await ctx.replyWithHTML(
          `✅ <b>Задание сохранено!</b>\n\n` +
          `Локация: ${db.locationGraph[location].name}\n` +
          `Текст: ${ctx.session.missionText.substring(0, 50)}...\n` +
          `Ответ: <code>${ctx.session.missionAnswer}</code>\n` +
          (imageUrl ? `🖼️ Изображение: ${imageUrl}` : `🖼️ Изображение: не задано`)
        );
        
        delete ctx.session.settingType;
        delete ctx.session.location;
        delete ctx.session.step;
        delete ctx.session.missionText;
        delete ctx.session.missionAnswer;
        await showAdminMenu(ctx, false);
      } catch (error) {
        console.error('❌ Ошибка сохранения задания:', error.message);
        await ctx.replyWithHTML(
          `❌ <b>Ошибка сохранения!</b>\n\n` +
          `Не удалось сохранить задание: ${error.message}\n\n` +
          `Пожалуйста, настройте задание заново.`
        );
        
        delete ctx.session.settingType;
        delete ctx.session.location;
        delete ctx.session.step;
        delete ctx.session.missionText;
        delete ctx.session.missionAnswer;
        await showAdminMenu(ctx, false);
      }
      
      return;
    }
    
    if (settingType === 'hint' && step === 'level') {
      const level = parseInt(text);
      if (isNaN(level) || level < 1 || level > 3) {
        await ctx.reply('❌ Уровень должен быть от 1 до 3. Попробуйте ещё раз:');
        return;
      }
      
      ctx.session.hintLevel = level;
      ctx.session.step = 'text';
      await ctx.replyWithHTML(
        `✏️ <b>Подсказка для "${db.locationGraph[location].name}" (уровень ${level})</b>\n\n` +
        `Отправьте текст подсказки:`
      );
      return;
    }
    
    if (settingType === 'hint' && step === 'text') {
      db.createHint(location, ctx.session.hintLevel, text);
      
      await ctx.replyWithHTML(
        `✅ <b>Подсказка создана!</b>\n\n` +
        `Локация: ${db.locationGraph[location].name}\n` +
        `Уровень: ${ctx.session.hintLevel}\n` +
        `Текст: ${text}`
      );
      
      delete ctx.session.settingType;
      delete ctx.session.location;
      delete ctx.session.step;
      delete ctx.session.hintLevel;
      await showAdminMenu(ctx, false);
      return;
    }
  }
});

bot.catch((err, ctx) => {
  // Игнорируем ошибку "message is not modified" — она не критична
  if (err?.response?.description?.includes('message is not modified')) {
    console.log(`ℹ️ Игнорируем не критичную ошибку "message is not modified" для пользователя ${ctx.from?.id}`);
    return;
  }
  
  // Игнорируем ошибку "message to edit not found" — сообщение уже удалено
  if (err?.response?.description?.includes('message to edit not found')) {
    console.log(`ℹ️ Игнорируем ошибку "message to edit not found" для пользователя ${ctx.from?.id}`);
    return;
  }
  
  // Все остальные ошибки логируем
  console.error(`⚠️ Ошибка обработки сообщения от ${ctx.from?.id}:`, err.message);
  console.error('Стек:', err.stack);
  
  // Отправляем пользователю уведомление об ошибке
  if (ctx?.from?.id) {
    ctx.telegram.sendMessage(
      ctx.from.id,
      `❌ Произошла ошибка при обработке вашего запроса.\n\n` +
      `Попробуйте выполнить действие ещё раз или напишите /start для перезапуска квеста.`,
      { parse_mode: 'HTML' }
    ).catch(e => console.error('Не удалось отправить сообщение об ошибке:', e.message));
  }
});

async function setupWebhook() {
  try {
    const publicUrl = process.env.RAILWAY_PUBLIC_DOMAIN || 
                     `https://${process.env.RAILWAY_STATIC_URL}`;
    const webhookUrl = `${publicUrl}/${WEBHOOK_SECRET}`;
    
    console.log(`📡 Настройка вебхука: ${webhookUrl}`);
    await bot.telegram.setWebhook(webhookUrl);
    
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log(`✅ Вебхук успешно настроен`);
    console.log(`ℹ️  Текущий вебхук: ${webhookInfo.url || 'не установлен'}`);
    console.log(`ℹ️  Ожидающих обновлений: ${webhookInfo.pending_update_count}`);
  } catch (error) {
    console.error('❌ Ошибка настройки вебхука:', error.message);
    console.error('Стек:', error.stack);
  }
}

server.listen(PORT, async () => {
  console.log(`✅ HTTP сервер запущен на порту ${PORT}`);
  console.log(`📁 Статические файлы: ${PUBLIC_DIR}`);
  console.log(`🛡️  SQLite настроен для многопользовательского режима:`);
  console.log(`   • PRAGMA journal_mode = WAL`);
  console.log(`   • PRAGMA busy_timeout = 30000ms`);
  console.log(`   • PRAGMA synchronous = NORMAL`);
  console.log(`   • PRAGMA temp_store = MEMORY`);
  console.log(`🛡️  Telegram API: защита от ошибки "message is not modified" ВКЛЮЧЕНА`);
  console.log(`🛡️  Автоматическая регистрация игроков: ВКЛЮЧЕНА`);
  console.log(``);
  console.log(`   GET /                 → index.html (фронтенд)`);
  console.log(`   GET /health           → health check`);
  console.log(`   POST /${WEBHOOK_SECRET} → вебхуки Telegram`);
  console.log(`   POST /check-password  → API: проверка пароля`);
  console.log(`   POST /get-mission     → API: получение задания`);
  console.log(`   POST /check-answer    → API: проверка ответа`);
  console.log(`   POST /request-hint    → API: запрос подсказки`);
  
  await setupWebhook();
  bot.webhookCallback(`/${WEBHOOK_SECRET}`, server);
  
  console.log(`\n✅ Telegram бот готов к работе`);
  console.log(`🔧 Админ ID: ${ADMIN_USER_IDS[0]}`);
  console.log(`🌐 Фронтенд URL: ${FRONTEND_URL}`);
  console.log(`✨ Упрощённая регистрация: 1 игрок = 1 команда`);
  console.log(`👥 Многопользовательский режим: ВКЛЮЧЁН`);
});

const stop = () => {
  console.log('🛑 Остановка системы...');
  server.close(() => {
    console.log('✅ Система остановлена');
    process.exit(0);
  });
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
