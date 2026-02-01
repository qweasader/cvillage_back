// index.js — исправленная версия с рабочей проверкой паролей
import { Telegraf } from 'telegraf';
import http from 'http';
import { URL } from 'url';
import { QuestDatabase } from './database.js';
import 'dotenv/config';

// ==================== КОНФИГУРАЦИЯ ====================
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://qweasader.github.io/cybervillage_defend/';
const PORT = process.env.PORT || 3000;

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

// Сессии в памяти
const sessions = new Map();
function getSession(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return null;
  if (!sessions.has(userId)) sessions.set(userId, {});
  return sessions.get(userId);
}

// ==================== HTTP СЕРВЕР ====================
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // ИЗВЛЕЧЕНИЕ USER ID ИЗ INITDATA — КРИТИЧЕСКИ ВАЖНО!
  let userId = null;
  const initData = req.headers['x-telegram-init-data'] || req.headers['x-telegram-init-data'] || '';
  
  if (initData) {
    try {
      // Парсим параметры из строки запроса
      const params = new URLSearchParams(initData);
      const userParam = params.get('user');
      
      if (userParam) {
        const userObj = JSON.parse(decodeURIComponent(userParam));
        userId = String(userObj.id); // Приводим к строке для надёжности
      }
    } catch (e) {
      console.error('Ошибка парсинга initData:', e.message);
    }
  }

  // Если не удалось извлечь userId — ошибка
  if (!userId) {
    console.warn('⚠️ Не удалось извлечь userId из initData:', initData.substring(0, 100));
    res.writeHead(401);
    res.end(JSON.stringify({ 
      success: false, 
      message: 'Не авторизован. Откройте приложение через Telegram!' 
    }));
    return;
  }

  // Парсинг тела
  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', async () => {
    try {
      const data = body ? JSON.parse(body) : {};

      // ============ ПРОВЕРКА ПАРОЛЯ ДОСТУПА — ИСПРАВЛЕНО ============
      if (pathname === '/check-password' && req.method === 'POST') {
        const { location, password } = data;
        
        if (!location || !password) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, message: 'Не указаны локация или пароль' }));
          return;
        }

        // 1. Создаём/получаем игрока (гарантируем существование)
        let player = db.getPlayer(userId);
        if (!player) {
          // Извлекаем данные из initData для инициализации
          let firstName = 'Игрок';
          try {
            const params = new URLSearchParams(initData);
            const userParam = params.get('user');
            if (userParam) {
              const userObj = JSON.parse(decodeURIComponent(userParam));
              firstName = userObj.first_name || 'Игрок';
            }
          } catch (e) {}
          
          db.createOrUpdatePlayer(userId, { first_name: firstName });
          player = db.getPlayer(userId);
          console.log(`🆕 Создан новый игрок: ${userId} (${firstName})`);
        }

        // 2. Проверяем, разблокирована ли локация
        const unlocked = JSON.parse(player.unlocked_locations || '["gates"]');
        
        // ИСПРАВЛЕНО: разрешаем доступ ТОЛЬКО к первой непройденной локации
        const completed = JSON.parse(player.completed_locations || '[]');
        const nextLocationIndex = completed.length;
        const expectedLocation = ALL_LOCATIONS[nextLocationIndex] || 'gates';
        
        if (location !== expectedLocation) {
          const expectedName = LOCATIONS[expectedLocation].name;
          res.writeHead(200);
          res.end(JSON.stringify({ 
            success: false, 
            message: `Эта локация ещё недоступна! Сначала завершите: ${expectedName}` 
          }));
          return;
        }

        // 3. Проверяем пароль
        const correctPassword = db.getPassword(location);
        const cleanInputPassword = password.trim();
        const isCorrect = correctPassword && cleanInputPassword === correctPassword;

        console.log(`🔑 Проверка пароля: локация=${location}, введено="${cleanInputPassword}", в БД="${correctPassword}", результат=${isCorrect}`);

        if (isCorrect) {
          db.logEvent('location_unlocked', userId, location);
          res.writeHead(200);
          res.end(JSON.stringify({ 
            success: true, 
            message: 'Пароль верный! Задание открыто.',
            locationName: LOCATIONS[location].name
          }));
        } else {
          // Логируем попытку для отладки
          db.logEvent('wrong_password', userId, location, { 
            input: cleanInputPassword.substring(0, 20),
            correct: correctPassword ? 'exists' : 'not_set'
          });
          
          res.writeHead(200);
          res.end(JSON.stringify({ 
            success: false, 
            message: correctPassword 
              ? 'Неверный пароль! Проверьте регистр и отсутствие пробелов.' 
              : 'Пароль для этой локации ещё не настроен администратором.'
          }));
        }
        return;
      }

      // ============ ПОЛУЧЕНИЕ ЗАДАНИЯ ============
      if (pathname === '/get-mission' && req.method === 'POST') {
        const { location } = data;
        
        if (!location) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Не указана локация' }));
          return;
        }

        // Проверяем, что игрок существует и локация разблокирована
        const player = db.getPlayer(userId);
        if (!player) {
          res.writeHead(403);
          res.end(JSON.stringify({ 
            error: 'not_initialized',
            message: 'Сначала введите пароль доступа к локации' 
          }));
          return;
        }

        const completed = JSON.parse(player.completed_locations || '[]');
        const nextLocationIndex = completed.length;
        const expectedLocation = ALL_LOCATIONS[nextLocationIndex] || 'gates';
        
        if (location !== expectedLocation) {
          res.writeHead(403);
          res.end(JSON.stringify({ 
            error: 'wrong_location',
            message: 'Эта локация ещё недоступна' 
          }));
          return;
        }

        const mission = db.getMission(location);
        if (!mission) {
          res.writeHead(404);
          res.end(JSON.stringify({ 
            error: 'mission_not_found',
            message: 'Задание ещё не настроено администратором' 
          }));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify({ 
          success: true,
          mission: {
            text: mission.text,
            imageUrl: mission.image_url
          },
          locationName: LOCATIONS[location].name
        }));
        return;
      }

      // ============ ПРОВЕРКА ОТВЕТА НА ЗАДАНИЕ ============
      if (pathname === '/check-answer' && req.method === 'POST') {
        const { location, answer } = data;
        
        if (!location || !answer) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, message: 'Не указаны локация или ответ' }));
          return;
        }

        const player = db.getPlayer(userId);
        if (!player) {
          res.writeHead(403);
          res.end(JSON.stringify({ success: false, message: 'Игрок не найден' }));
          return;
        }

        const mission = db.getMission(location);
        if (!mission) {
          res.writeHead(404);
          res.end(JSON.stringify({ success: false, message: 'Задание не найдено' }));
          return;
        }

        const isCorrect = answer.trim().toLowerCase() === mission.answer.toLowerCase();
        
        if (isCorrect) {
          db.completeLocation(userId, location);
          db.logEvent('location_completed', userId, location);
          
          const updatedPlayer = db.getPlayer(userId);
          const completed = JSON.parse(updatedPlayer.completed_locations || '[]');
          const isQuestComplete = completed.length >= 6;
          const nextLocation = completed.length < 6 ? ALL_LOCATIONS[completed.length] : null;
          
          res.writeHead(200);
          res.end(JSON.stringify({ 
            success: true, 
            message: 'Верно! Локация пройдена!',
            nextLocation: nextLocation,
            nextLocationName: nextLocation ? LOCATIONS[nextLocation].name : null,
            questComplete: isQuestComplete
          }));
        } else {
          db.logEvent('wrong_answer', userId, location, { 
            input: answer.trim().substring(0, 20) 
          });
          res.writeHead(200);
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Неверный ответ! Попробуйте ещё раз или запросите подсказку.' 
          }));
        }
        return;
      }

      // ============ ЗАПРОС ПОДСКАЗКИ ============
      if (pathname === '/request-hint' && req.method === 'POST') {
        const { location, hintLevel = 1 } = data;
        
        if (!location) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Не указана локация' }));
          return;
        }

        const player = db.getPlayer(userId);
        if (!player) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Игрок не найден' }));
          return;
        }

        if (player.hints_used >= 3) {
          res.writeHead(200);
          res.end(JSON.stringify({ 
            success: false,
            error: 'no_hints_left',
            message: 'У вас закончились подсказки!'
          }));
          return;
        }

        const hint = db.getHint(location, hintLevel);
        if (!hint) {
          res.writeHead(404);
          res.end(JSON.stringify({ 
            success: false,
            error: 'not_found',
            message: 'Подсказка не найдена' 
          }));
          return;
        }

        db.useHint(userId);
        db.logEvent('hint_used', userId, location, { level: hintLevel });

        res.writeHead(200);
        res.end(JSON.stringify({ 
          success: true,
          text: hint.text,
          hintsUsed: player.hints_used + 1,
          hintsLeft: 3 - (player.hints_used + 1)
        }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      console.error('❌ Ошибка сервера:', error);
      console.error('Стек:', error.stack);
      res.writeHead(500);
      res.end(JSON.stringify({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      }));
    }
  });
});

// ==================== TELEGRAM БОТ (минимальная версия для админки) ====================
bot.use((ctx, next) => {
  ctx.isAdmin = ADMIN_USER_IDS.includes(ctx.from?.id);
  ctx.session = getSession(ctx);
  return next();
});

bot.start((ctx) => {
  ctx.replyWithHTML(
    `👋 <b>Защита Кибердеревни</b>\n\n` +
    `Начните квест через веб-приложение:`,
    {
      reply_markup: {
        inline_keyboard: [[{
          text: '🚀 Начать квест',
          web_app: { url: FRONTEND_URL }
        }]]
      }
    }
  );
});

bot.command('admin', async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.replyWithHTML(`🚫 Доступ запрещён. Ваш ID: <code>${ctx.from.id}</code>`);
    return;
  }
  
  const pwdCount = db.getAllPasswords().length;
  const missionCount = db.getAllMissions().length;
  const hintCount = db.db.prepare('SELECT COUNT(*) as cnt FROM hints').get().cnt;
  
  const message = `🔧 <b>Админ-панель квеста</b>\n\n` +
    `✅ Паролей: ${pwdCount}/6\n` +
    `✅ Заданий: ${missionCount}/6\n` +
    `✅ Подсказок: ${hintCount}\n\n` +
    `<b>Выберите раздел:</b>`;
  
  // ПРАВИЛЬНЫЙ СИНТАКСИС КНОПОК (без ошибок!)
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔑 Пароли', callback_ 'admin_passwords' }],
      [{ text: '📝 Задания', callback_ 'admin_missions' }],
      [{ text: '💡 Подсказки', callback_ 'admin_hints' }]
    ]
  };
  
  await ctx.reply(message, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

// Пароли
bot.action('admin_passwords', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const passwords = db.getAllPasswords();
  let msg = `🔑 <b>Пароли локаций</b>\n\n`;
  ALL_LOCATIONS.forEach(id => {
    const pwd = passwords.find(p => p.location === id);
    msg += `${pwd ? '✅' : '❌'} ${LOCATIONS[id].emoji} ${LOCATIONS[id].name}: ` +
           `<code>${pwd?.password || 'не задан'}</code>\n`;
  });
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🚪 Врата', callback_ 'set_pwd_gates' },
        { text: '🛡️ Купол', callback_ 'set_pwd_dome' }
      ],
      [
        { text: '🪞 Зеркало', callback_ 'set_pwd_mirror' },
        { text: '🔮 Камень', callback_ 'set_pwd_stone' }
      ],
      [
        { text: '🏠 Хижина', callback_ 'set_pwd_hut' },
        { text: '👾 Логово', callback_ 'set_pwd_lair' }
      ],
      [{ text: '🔙 Назад', callback_ 'admin_main' }]
    ]
  };
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
});

// Установка пароля (пример для одной локации, остальные аналогично)
bot.action(/set_pwd_(.+)/, async (ctx) => {
  if (!ctx.isAdmin) return;
  const loc = ctx.match[1];
  ctx.session = { setting: 'password', location: loc };
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(`🔑 Пароль для "${LOCATIONS[loc].name}":`);
});

bot.on('text', async (ctx) => {
  if (!ctx.isAdmin || !ctx.session?.setting) return;
  
  if (ctx.session.setting === 'password') {
    const pwd = ctx.message.text.trim();
    if (pwd.length < 4) {
      await ctx.reply('⚠️ Пароль должен быть не менее 4 символов');
      return;
    }
    db.setPassword(ctx.session.location, pwd);
    await ctx.replyWithHTML(`✅ Пароль для "${LOCATIONS[ctx.session.location].name}" установлен: <code>${pwd}</code>`);
    delete ctx.session.setting;
    delete ctx.session.location;
  }
});

// Запуск
server.listen(PORT, () => {
  console.log(`✅ HTTP сервер запущен: http://localhost:${PORT}`);
  console.log(`   POST /check-password  - проверка пароля`);
  console.log(`   POST /get-mission     - получение задания`);
  console.log(`   POST /check-answer    - проверка ответа`);
  console.log(`   POST /request-hint    - запрос подсказки`);
});

bot.launch();
console.log('✅ Telegram бот запущен');
console.log('🔧 Админ ID:', ADMIN_USER_IDS[0]);

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  server.close();
});
