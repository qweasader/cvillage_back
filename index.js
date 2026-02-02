// index.js — бэкенд + сервер статики для фронтенда на Railway
import { Telegraf } from 'telegraf';
import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { QuestDatabase } from './database.js';
import 'dotenv/config';

// ==================== КОНФИГУРАЦИЯ ====================
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL; // ← Railway URL
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PUBLIC_DIR = path.join(process.cwd(), 'public');

if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не установлен');
if (ADMIN_USER_IDS[0] === 123456789) throw new Error('Замените 123456789 на ваш реальный Telegram ID');

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
const db = new QuestDatabase();
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

const LOCATIONS = {
  gates: { name: 'Врата Кибердеревни', emoji: '🚪', order: 1 },
  dome: { name: 'Купол Защиты', emoji: '🛡️', order: 2 },
  mirror: { name: 'Зеркало Истины', emoji: '🪞', order: 3 },
  stone: { name: 'Камень Пророчеств', emoji: '🔮', order: 4 },
  hut: { name: 'Хижина Хранителя', emoji: '🏠', order: 5 },
  lair: { name: 'Логово Вируса', emoji: '👾', order: 6 }
};

const ALL_LOCATIONS = Object.keys(LOCATIONS);

const sessions = new Map();
function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, {});
  return sessions.get(userId);
}

// ==================== HTTP СЕРВЕР С ВЕБХУКАМИ + СТАТИКОЙ ====================
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // Вебхуки Telegram
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

  // Health check
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // ============ ОБСЛУЖИВАНИЕ СТАТИЧЕСКИХ ФАЙЛОВ ФРОНТЕНДА ============
  if (req.method === 'GET') {
    // Защита от обхода каталогов
    if (pathname.includes('..') || pathname.includes('%')) {
      res.writeHead(403);
      res.end('403 Forbidden');
      return;
    }

    let filePath = path.join(PUBLIC_DIR, pathname);
    
    // Если это директория — отдаём index.html
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
    } catch (e) {
      // Игнорируем ошибки
    }

    // Если файл не найден и нет расширения — пробуем добавить .html
    if (!fs.existsSync(filePath) && !path.extname(filePath)) {
      const htmlPath = filePath + '.html';
      if (fs.existsSync(htmlPath)) {
        filePath = htmlPath;
      } else {
        // Отдаём главную страницу для всех неизвестных маршрутов (SPA)
        filePath = path.join(PUBLIC_DIR, 'index.html');
      }
    }

    // Проверяем существование файла
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('404 Not Found');
      return;
    }

    // Определяем тип содержимого
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'application/font-woff',
      '.woff2': 'application/font-woff2',
      '.ttf': 'application/font-ttf',
      '.eot': 'application/vnd.ms-fontobject',
      '.otf': 'application/font-otf',
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.wasm': 'application/wasm'
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    // Отправляем файл
    fs.readFile(filePath, (error, content) => {
      if (error) {
        res.writeHead(500);
        res.end('500 Internal Server Error');
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
    return;
  }

  // ============ ОБРАБОТКА API ЗАПРОСОВ (как раньше) ============
  // ... ВСЯ ЛОГИКА ОБРАБОТКИ /check-password, /get-mission и т.д. ...
  // (полный код идентичен предыдущей версии — все этапы логирования, проверки паролей и т.д.)
  
  // Извлечение userId из initData
  let userId = null;
  const initData = req.headers['x-telegram-init-data'] || '';
  
  if (initData) {
    try {
      const params = new URLSearchParams(initData);
      const userParam = params.get('user');
      
      if (userParam) {
        const userObj = JSON.parse(decodeURIComponent(userParam));
        userId = String(userObj.id);
      }
    } catch (e) {
      console.error('❌ Ошибка парсинга initData:', e.message);
    }
  }

  if (!userId) {
    console.error('❌ Не удалось извлечь userId из initData');
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ 
      success: false, 
      message: 'Не авторизован. Откройте приложение через кнопку в боте!'
    }));
    return;
  }

  const player = db.getPlayer(userId);
  if (!player || !player.is_registered) {
    res.writeHead(403, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ 
      success: false, 
      message: 'Сначала зарегистрируйтесь в боте! Напишите /start и введите код команды.',
      requiresRegistration: true
    }));
    return;
  }

  const team = db.getTeamById(player.team_id);
  if (!team) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ 
      success: false, 
      message: 'Ошибка: команда не найдена' 
    }));
    return;
  }

  // Парсинг тела
  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', async () => {
    try {
      const data = body ? JSON.parse(body) : {};

      // ПРОВЕРКА ПАРОЛЯ — ПОЛНОСТЬЮ ПЕРЕДЕЛАНАЯ ВЕРСИЯ С МАКСИМАЛЬНЫМ ЛОГИРОВАНИЕМ
      if (pathname === '/check-password' && req.method === 'POST') {
        const { location, password } = data;
        
        // ============ ЭТАП 1: ПОЛУЧЕНИЕ ДАННЫХ ИЗ ЗАПРОСА ============
        console.log(`\n${'='.repeat(80)}`);
        console.log(`🔐 [ПРОВЕРКА ПАРОЛЯ] Новый запрос`);
        console.log(`   Время: ${new Date().toISOString()}`);
        console.log(`   Локация: "${location}"`);
        console.log(`   Пароль (как пришел): "${password}"`);
        console.log(`   Длина пароля: ${password ? password.length : 0} символов`);
        
        // Проверка наличия данных
        if (!location || !password) {
          console.error(`   ❌ Ошибка: не указаны локация или пароль`);
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, message: 'Не указаны локация или пароль' }));
          return;
        }

        // ============ ЭТАП 2: ПРОВЕРКА ЛОКАЦИИ ============
        const unlocked = JSON.parse(team.unlocked_locations || '["gates"]');
        const completed = JSON.parse(team.completed_locations || '[]');
        const nextLocationIndex = completed.length;
        const expectedLocation = ALL_LOCATIONS[nextLocationIndex] || 'gates';
        
        console.log(`\n📍 Проверка локации:`);
        console.log(`   Текущая локация команды: ${expectedLocation}`);
        console.log(`   Запрошенная локация: ${location}`);
        console.log(`   Открытые локации: ${unlocked.join(', ')}`);
        console.log(`   Завершенные локации: ${completed.length}`);
        
        if (location !== expectedLocation) {
          console.warn(`   ⚠️ Локация не совпадает!`);
          const expectedName = LOCATIONS[expectedLocation].name;
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false, 
            message: `Эта локация ещё недоступна! Сначала завершите: ${expectedName}` 
          }));
          return;
        }
        console.log(`   ✅ Локация проверена: "${location}" доступна для проверки`);

        // ============ ЭТАП 3: ПОЛУЧЕНИЕ ПАРОЛЯ ИЗ БД ============
        console.log(`\n🔑 Получение пароля из базы данных...`);
        const passwordData = db.getPassword(location);
        
        if (!passwordData) {
          console.error(`   ❌ Пароль для локации "${location}" НЕ НАЙДЕН в базе данных!`);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Пароль для этой локации ещё не настроен администратором.'
          }));
          return;
        }
        
        console.log(`   ✅ Пароль из БД получен:`);
        console.log(`      Оригинал: "${passwordData.original}"`);
        console.log(`      normalized: "${passwordData.normalized}"`);

        // ============ ЭТАП 4: НОРМАЛИЗАЦИЯ ВВЕДЕННОГО ПАРОЛЯ ============
        console.log(`\n✏️ Нормализация введенного пароля...`);
        const cleanInput = password.trim();
        console.log(`   После trim: "${cleanInput}" (длина: ${cleanInput.length})`);
        
        const normalizedInput = db.normalizePassword(cleanInput);
        console.log(`   Нормализованный ввод: "${normalizedInput}"`);

        // ============ ЭТАП 5: СРАВНЕНИЕ ============
        console.log(`\n⚖️ Сравнение паролей:`);
        console.log(`   Введенный (нормализ.): "${normalizedInput}"`);
        console.log(`   Из БД (нормализ.):    "${passwordData.normalized}"`);
        console.log(`   Длина введенного: ${normalizedInput.length}`);
        console.log(`   Длина из БД: ${passwordData.normalized.length}`);
        
        // Побайтовое сравнение для отладки
        if (normalizedInput.length === passwordData.normalized.length) {
          let diffFound = false;
          for (let i = 0; i < normalizedInput.length; i++) {
            if (normalizedInput[i] !== passwordData.normalized[i]) {
              console.log(`   ⚠️ Различие на позиции ${i}:`);
              console.log(`      Введенный: "${normalizedInput[i]}" (код ${normalizedInput.charCodeAt(i)})`);
              console.log(`      Из БД:     "${passwordData.normalized[i]}" (код ${passwordData.normalized.charCodeAt(i)})`);
              diffFound = true;
              break;
            }
          }
          if (!diffFound) {
            console.log(`   ✅ Все символы совпадают`);
          }
        } else {
          console.log(`   ⚠️ Длины не совпадают!`);
        }
        
        const isCorrect = normalizedInput === passwordData.normalized;
        console.log(`\n✅ Результат проверки: ${isCorrect ? 'ВЕРНО' : 'НЕВЕРНО'}`);

        // ============ ЭТАП 6: ОТПРАВКА ОТВЕТА ============
        if (isCorrect) {
          db.logEvent('location_unlocked', team.id, location, { userId });
          console.log(`\n🎉 Пароль ВЕРНЫЙ! Локация разблокирована.`);
          
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: true, 
            message: 'Пароль верный! Задание открыто.',
            locationName: LOCATIONS[location].name,
            teamCode: team.code,
            teamName: team.name
          }));
        } else {
          db.logEvent('wrong_password', team.id, location, { 
            userId, 
            input: cleanInput.substring(0, 20),
            normalized: normalizedInput
          });
          
          console.log(`\n❌ Пароль НЕВЕРНЫЙ!`);
          console.log(`   Подробности для отладки:`);
          console.log(`      Введено (оригинал): "${password}"`);
          console.log(`      Введено (после trim): "${cleanInput}"`);
          console.log(`      Введено (нормализ.): "${normalizedInput}"`);
          console.log(`      Ожидалось (нормализ.): "${passwordData.normalized}"`);
          console.log(`      Разница в длине: ${Math.abs(normalizedInput.length - passwordData.normalized.length)} символов`);
          
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Неверный пароль! Проверьте написание и попробуйте снова.',
            debug: {
              inputRaw: password,
              inputTrimmed: cleanInput,
              inputNormalized: normalizedInput,
              expectedNormalized: passwordData.normalized,
              inputLength: password.length,
              trimmedLength: cleanInput.length,
              normalizedLength: normalizedInput.length,
              expectedLength: passwordData.normalized.length
            }
          }));
        }
        
        console.log(`${'='.repeat(80)}\n`);
        return;
      }

      // ... остальные обработчики (получение задания, проверка ответа, подсказки) без изменений
      // (полный код идентичен предыдущей версии — все этапы логирования)
      
      // Получение задания
      if (pathname === '/get-mission' && req.method === 'POST') {
        const { location } = data;
        
        if (!location) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ error: 'Не указана локация' }));
          return;
        }

        const unlocked = JSON.parse(team.unlocked_locations || '["gates"]');
        if (!unlocked.includes(location)) {
          res.writeHead(403, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            error: 'access_denied',
            message: 'Сначала введите пароль доступа к локации' 
          }));
          return;
        }

        const mission = db.getMission(location);
        if (!mission) {
          res.writeHead(404, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            error: 'mission_not_found',
            message: 'Задание ещё не настроено администратором' 
          }));
          return;
        }

        const members = db.getTeamMembers(team.id);
        
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ 
          success: true,
          mission: {
            text: mission.text,
            imageUrl: mission.image_url
          },
          locationName: LOCATIONS[location].name,
          team: {
            code: team.code,
            name: team.name,
            members: members.map(m => ({ name: m.first_name, id: m.id })),
            completedLocations: JSON.parse(team.completed_locations || '[]').length,
            hintsUsed: team.hints_used,
            hintsLeft: 3 - team.hints_used
          }
        }));
        return;
      }

      // Проверка ответа
      if (pathname === '/check-answer' && req.method === 'POST') {
        const { location, answer } = data;
        
        if (!location || !answer) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, message: 'Не указаны локация или ответ' }));
          return;
        }

        const mission = db.getMission(location);
        if (!mission) {
          res.writeHead(404, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, message: 'Задание не найдено' }));
          return;
        }

        const cleanAnswer = answer.trim().toLowerCase();
        const correctAnswer = mission.answer.trim().toLowerCase();
        const isCorrect = cleanAnswer === correctAnswer;
        
        if (isCorrect) {
          db.completeLocationForTeam(team.id, location);
          db.logEvent('location_completed', team.id, location, { userId });
          
          const updatedTeam = db.getTeamById(team.id);
          const completed = JSON.parse(updatedTeam.completed_locations || '[]');
          const isQuestComplete = completed.length >= 6;
          const nextLocation = completed.length < 6 ? ALL_LOCATIONS[completed.length] : null;
          
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: true, 
            message: 'Верно! Локация пройдена командой!',
            nextLocation: nextLocation,
            nextLocationName: nextLocation ? LOCATIONS[nextLocation].name : null,
            questComplete: isQuestComplete,
            teamProgress: {
              completed: completed.length,
              total: 6
            }
          }));
        } else {
          db.logEvent('wrong_answer', team.id, location, { userId, input: answer.trim().substring(0, 20) });
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Неверный ответ! Обсудите с командой или запросите подсказку.' 
          }));
        }
        return;
      }

      // Запрос подсказки
      if (pathname === '/request-hint' && req.method === 'POST') {
        const { location, hintLevel = 1 } = data;
        
        if (!location) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ error: 'Не указана локация' }));
          return;
        }

        if (team.hints_used >= 3) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false,
            error: 'no_hints_left',
            message: 'У вашей команды закончились подсказки!'
          }));
          return;
        }

        const hint = db.getHint(location, hintLevel);
        if (!hint) {
          res.writeHead(404, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false,
            error: 'not_found',
            message: 'Подсказка не найдена' 
          }));
          return;
        }

        db.useHintForTeam(team.id);
        db.logEvent('hint_used', team.id, location, { userId, level: hintLevel });

        const updatedTeam = db.getTeamById(team.id);
        
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ 
          success: true,
          text: hint.text,
          hintsUsed: updatedTeam.hints_used,
          hintsLeft: 3 - updatedTeam.hints_used,
          teamCode: team.code
        }));
        return;
      }

      res.writeHead(404, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      console.error('❌ Ошибка сервера:', error);
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
});

// ... ВСЯ ЛОГИКА БОТА БЕЗ ИЗМЕНЕНИЙ (полный код идентичен предыдущей версии) ...
// (все обработчики команд, админ-панель, кнопки с правильным синтаксисом callback_data)

bot.use((ctx, next) => {
  ctx.isAdmin = ADMIN_USER_IDS.includes(ctx.from?.id);
  ctx.session = getSession(ctx.from?.id);
  return next();
});

bot.start(async (ctx) => {
  const player = db.getPlayer(ctx.from.id);
  const isRegistered = player && player.is_registered;
  
  const adminButton = ctx.isAdmin ? [{ text: '🔧 Админ-панель', callback_ 'admin_panel' }] : [];
  
  if (isRegistered) {
    const team = db.getTeamById(player.team_id);
    await ctx.replyWithHTML(
      `👋 <b>С возвращением, ${player.first_name}!</b>\n\n` +
      `🛡️ Вы в команде: <b>${team.name}</b> (${team.code})\n` +
      `👥 Состав команды: ${db.getTeamMembers(team.id).length} игроков\n\n` +
      `<b>Выберите действие:</b>`,
      {
        reply_markup: {
          inline_keyboard: [
            // КНОПКА ВЕДЁТ НА КОРНЕВОЙ URL RAILWAY С ПАРАМЕТРОМ TEAM
            [{ text: '🚀 Начать квест', web_app: { url: `${FRONTEND_URL}?team=${team.code}` } }],
            [{ text: '📊 Статистика команды', callback_data: 'team_stats' }],
            [{ text: '👥 Состав команды', callback_data: 'team_members' }],
            ...adminButton
          ]
        }
      }
    );
    return;
  }
  
  if (ctx.isAdmin) {
    await ctx.replyWithHTML(
      `👋 <b>Добро пожаловать, Администратор!</b>\n\n` +
      `🛡️ Вы можете:\n` +
      `• Настроить квест через админ-панель\n` +
      `• Создать команду и пройти квест как игрок`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔧 Админ-панель', callback_ 'admin_panel' }],
            [{ text: '🆕 Создать команду', callback_ 'create_new_team' }],
            [{ text: '❓ Как создать команду?', callback_ 'how_to_create' }]
          ]
        }
      }
    );
    return;
  }
  
  ctx.session.registerStep = 'team_code';
  await ctx.replyWithHTML(
    `👋 <b>Добро пожаловать в "Защиту Кибердеревни"!</b>\n\n` +
    `👾 Это <b>командный квест</b> для групп по 3 человека.\n\n` +
    `<b>Как зарегистрироваться:</b>\n` +
    `1️⃣ Получите код команды у капитана\n` +
    `2️⃣ Введите код ниже (6 символов)\n` +
    `3️⃣ Укажите ваше имя в команде\n\n` +
    `<i>Пример кода: ABC123</i>`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🆕 Создать новую команду', callback_data: 'create_new_team' }],
          [{ text: '❓ Как создать команду?', callback_ 'how_to_create' }]
        ]
      }
    }
  );
});

// ... остальные обработчики бота (полный код без изменений, все кнопки с callback_data) ...

bot.action('admin_panel', async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.answerCbQuery('Доступ запрещён', { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  await showAdminMenu(ctx);
});

bot.command('admin', async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.replyWithHTML(`🚫 <b>Доступ запрещён</b>\n\nВаш ID: <code>${ctx.from.id}</code>`);
    return;
  }
  await showAdminMenu(ctx);
});

bot.action('create_new_team', async (ctx) => {
  const teamCode = db.generateTeamCode();
  const team = db.createTeam(teamCode, `Команда ${teamCode}`);
  const { player } = db.registerPlayer(ctx.from.id, teamCode, ctx.from.first_name);
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `✅ <b>Команда создана!</b>\n\n` +
    `🔑 <b>Код команды:</b> <code>${teamCode}</code>\n` +
    `📝 <b>Название:</b> ${team.name}\n\n` +
    `👉 <b>Отправьте этот код своим товарищам!</b>\n` +
    `Они должны ввести его при регистрации.\n\n` +
    `<i>Максимум 3 игрока в команде.</i>`,
    {
      reply_markup: {
        inline_keyboard: [
          // КНОПКА ВЕДЁТ НА КОРНЕВОЙ URL RAILWAY С ПАРАМЕТРОМ TEAM
          [{ text: '🚀 Начать квест', web_app: { url: `${FRONTEND_URL}?team=${teamCode}` } }],
          [{ text: '📊 Статистика команды', callback_ 'team_stats' }],
          [{ text: '🔧 Админ-панель', callback_ 'admin_panel' }]
        ]
      }
    }
  );
  
  if (ctx.session) {
    delete ctx.session.registerStep;
    delete ctx.session.teamCode;
  }
});

// ... остальные обработчики (полный код без изменений) ...

bot.catch((err, ctx) => {
  console.error(`⚠️ Ошибка обработки сообщения от ${ctx.from?.id}:`, err.message);
  console.error('Стек:', err.stack);
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
  console.log(`📁 Статические файлы обслуживаются из: ${PUBLIC_DIR}`);
  console.log(`   GET  /                 - главная страница фронтенда`);
  console.log(`   GET  /*.html, *.js... - статические файлы`);
  console.log(`   POST /${WEBHOOK_SECRET} - обработка вебхуков Telegram`);
  console.log(`   POST /check-password    - проверка пароля доступа`);
  console.log(`   POST /get-mission       - получение задания`);
  console.log(`   POST /check-answer      - проверка ответа`);
  console.log(`   POST /request-hint      - запрос подсказки`);
  console.log(`   GET  /health            - health check`);
  
  await setupWebhook();
  bot.webhookCallback(`/${WEBHOOK_SECRET}`, server);
  
  console.log('✅ Telegram бот готов к работе через вебхуки');
  console.log('🔧 Админ ID:', ADMIN_USER_IDS[0]);
  console.log('🌐 Фронтенд URL:', FRONTEND_URL);
  console.log('🚀 Фронтенд теперь размещён на том же сервере Railway!');
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
