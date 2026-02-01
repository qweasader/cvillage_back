// index.js — полная квест-система: бот + сервер
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
  // CORS
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

  // Извлекаем userId из initData
  const initData = req.headers['x-telegram-init-data'] || '';
  let userId = null;
  if (initData.includes('user=')) {
    try {
      const userPart = initData.split('user=')[1].split('&')[0];
      const userObj = JSON.parse(decodeURIComponent(userPart));
      userId = userObj.id;
    } catch (e) {
      console.error('Ошибка парсинга initData:', e);
    }
  }

  // Парсинг тела запроса
  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', async () => {
    try {
      const data = body ? JSON.parse(body) : {};

      // ============ ПРОВЕРКА ПАРОЛЯ ДОСТУПА ============
      if (pathname === '/check-password' && req.method === 'POST') {
        const { location, password } = data;
        
        if (!location || !password || !userId) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, message: 'Недостаточно данных' }));
          return;
        }

        const correctPassword = db.getPassword(location);
        const isCorrect = correctPassword && password.trim() === correctPassword;

        if (isCorrect) {
          // Проверяем, разблокирована ли локация
          const player = db.getPlayer(userId);
          const unlocked = JSON.parse(player?.unlocked_locations || '["gates"]');
          
          if (!unlocked.includes(location)) {
            res.writeHead(403);
            res.end(JSON.stringify({ 
              success: false, 
              message: 'Эта локация ещё не открыта. Завершите предыдущую локацию!' 
            }));
            return;
          }

          db.logEvent('location_unlocked', userId, location);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: 'Пароль верный! Задание открыто.' }));
        } else {
          db.logEvent('wrong_password', userId, location, { attempts: 1 });
          res.writeHead(200);
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Неверный пароль! Проверьте регистр и пробелы.' 
          }));
        }
        return;
      }

      // ============ ПОЛУЧЕНИЕ ЗАДАНИЯ ============
      if (pathname === '/get-mission' && req.method === 'POST') {
        const { location } = data;
        
        if (!location || !userId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Недостаточно данных' }));
          return;
        }

        // Проверяем, введён ли правильный пароль (локация разблокирована)
        const player = db.getPlayer(userId);
        const unlocked = JSON.parse(player?.unlocked_locations || '["gates"]');
        
        if (!unlocked.includes(location)) {
          res.writeHead(403);
          res.end(JSON.stringify({ 
            error: 'access_denied',
            message: 'Сначала введите пароль доступа к локации' 
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
          }
        }));
        return;
      }

      // ============ ПРОВЕРКА ОТВЕТА НА ЗАДАНИЕ ============
      if (pathname === '/check-answer' && req.method === 'POST') {
        const { location, answer } = data;
        
        if (!location || !answer || !userId) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, message: 'Недостаточно данных' }));
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
          // Завершаем локацию
          db.completeLocation(userId, location);
          db.logEvent('location_completed', userId, location);
          
          // Проверяем, завершен ли квест
          const player = db.getPlayer(userId);
          const completed = JSON.parse(player.completed_locations || '[]');
          const isQuestComplete = completed.length >= 6;
          
          res.writeHead(200);
          res.end(JSON.stringify({ 
            success: true, 
            message: 'Верно! Локация пройдена!',
            nextLocation: completed.length < 6 ? Object.keys(LOCATIONS)[completed.length] : null,
            questComplete: isQuestComplete
          }));
        } else {
          db.logEvent('wrong_answer', userId, location);
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
        
        if (!location || !userId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Недостаточно данных' }));
          return;
        }

        const player = db.getPlayer(userId);
        if (!player) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Player not found' }));
          return;
        }

        if (player.hints_used >= 3) {
          res.writeHead(400);
          res.end(JSON.stringify({ 
            error: 'no_hints_left',
            message: 'У вас закончились подсказки!'
          }));
          return;
        }

        const hint = db.getHint(location, hintLevel);
        if (!hint) {
          res.writeHead(404);
          res.end(JSON.stringify({ 
            error: 'not_found',
            message: 'Подсказка не найдена' 
          }));
          return;
        }

        // Используем подсказку
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

      // Неизвестный эндпоинт
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      console.error('Ошибка сервера:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
});

// ==================== TELEGRAM БОТ ====================
bot.use((ctx, next) => {
  ctx.isAdmin = ADMIN_USER_IDS.includes(ctx.from?.id);
  ctx.session = getSession(ctx);
  return next();
});

// Команда /start
bot.start(async (ctx) => {
  await db.createOrUpdatePlayer(ctx.from.id, {
    username: ctx.from.username,
    first_name: ctx.from.first_name,
    last_name: ctx.from.last_name
  });
  
  await ctx.replyWithHTML(
    `👋 <b>Добро пожаловать в "Защиту Кибердеревни"!</b>\n\n` +
    `👾 Вирус "Тень Сети" атакует нашу деревню!\n` +
    `🛡️ Твоя миссия — пройти 6 локаций и собрать все амулеты защиты.\n\n` +
    `<b>Правила прохождения:</b>\n` +
    `1️⃣ Введи пароль доступа к локации (найди его на территории)\n` +
    `2️⃣ Выполни задание и введи правильный ответ\n` +
    `3️⃣ Следующая локация откроется автоматически\n\n` +
    `<b>Доступные команды:</b>\n` +
    `/start - начать игру\n` +
    `/hint - запросить подсказку (3 шт.)\n` +
    `/stats - статистика`,
    {
      reply_markup: {
        inline_keyboard: [[{
          text: '🚀 Начать квест',
          web_app: { url: FRONTEND_URL }
        }]]
      }
    }
  );
  await db.logEvent('bot_start', ctx.from.id);
});

// Команда /stats
bot.command('stats', async (ctx) => {
  const player = await db.getPlayer(ctx.from.id);
  if (!player) {
    await ctx.reply('Сначала начните игру командой /start');
    return;
  }
  
  const completed = JSON.parse(player.completed_locations || '[]').length;
  const unlocked = JSON.parse(player.unlocked_locations || '["gates"]').length;
  const hintsLeft = 3 - player.hints_used;
  
  await ctx.replyWithHTML(
    `📊 <b>Ваша статистика</b>\n\n` +
    `👤 Игрок: ${player.first_name}\n` +
    `✅ Пройдено локаций: ${completed}/6\n` +
    `🔓 Открыто локаций: ${unlocked}/6\n` +
    `💡 Осталось подсказок: ${hintsLeft}/3`
  );
});

// Команда /hint
bot.command('hint', async (ctx) => {
  const player = await db.getPlayer(ctx.from.id);
  if (!player) {
    await ctx.reply('Сначала начните игру командой /start');
    return;
  }
  
  if (player.hints_used >= 3) {
    await ctx.reply('🚫 У вас закончились подсказки!');
    return;
  }
  
  // Определяем текущую локацию (последняя разблокированная)
  const unlocked = JSON.parse(player.unlocked_locations || '["gates"]');
  const currentLocation = unlocked[unlocked.length - 1];
  
  const hintLevel = player.hints_used + 1;
  const hint = await db.getHint(currentLocation, hintLevel);
  
  if (!hint) {
    await ctx.reply('🤔 Подсказка для текущей локации не настроена.');
    return;
  }
  
  // Используем подсказку
  db.useHint(ctx.from.id);
  await db.logEvent('hint_used', ctx.from.id, currentLocation, { level: hintLevel });
  
  const hintsLeft = 3 - (player.hints_used + 1);
  
  await ctx.replyWithHTML(
    `💡 <b>Подсказка для "${LOCATIONS[currentLocation].name}"</b>\n\n` +
    `${hint.text}\n\n` +
    `Осталось подсказок: ${hintsLeft}/3`
  );
});

// Команда /admin — ПОЛНОЦЕННАЯ АДМИН-ПАНЕЛЬ
bot.command('admin', async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.replyWithHTML(
      `🚫 <b>Доступ запрещён</b>\n\n` +
      `Ваш ID: <code>${ctx.from.id}</code>`
    );
    return;
  }
  
  await showAdminMenu(ctx);
});

// Главное меню админки
async function showAdminMenu(ctx) {
  const pwdCount = db.getAllPasswords().length;
  const missionCount = db.getAllMissions().length;
  const hintCount = db.db.prepare('SELECT COUNT(*) as cnt FROM hints').get().cnt;
  
  const message = `🔧 <b>Админ-панель квеста</b>\n\n` +
    `✅ Паролей задано: ${pwdCount}/6\n` +
    `✅ Заданий настроено: ${missionCount}/6\n` +
    `✅ Подсказок создано: ${hintCount}\n\n` +
    `<b>Выберите раздел для управления:</b>`;
  
  // ИСПРАВЛЕНО: правильный синтаксис всех кнопок
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔑 Пароли доступа', callback_ 'admin_passwords' }],
      [{ text: '📝 Задания локаций', callback_ 'admin_missions' }],
      [{ text: '💡 Подсказки', callback_ 'admin_hints' }],
      [{ text: '📊 Статистика', callback_ 'admin_stats' }]
    ]
  };
  
  if (ctx.callbackQuery) {
    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
    await ctx.answerCbQuery();
  } else {
    await ctx.reply(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }
}

// ============ МЕНЮ ПАРОЛЕЙ ============
bot.action('admin_passwords', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const passwords = db.getAllPasswords();
  
  let msg = `🔑 <b>Пароли доступа к локациям</b>\n\n` +
    `<i>Эти пароли игроки вводят для открытия задания на локации</i>\n\n`;
  
  Object.entries(LOCATIONS).forEach(([id, loc]) => {
    const pwd = passwords.find(p => p.location === id);
    msg += `${pwd ? '✅' : '❌'} ${loc.emoji} ${loc.name}: ` +
           `<code>${pwd?.password || 'не задан'}</code>\n`;
  });
  
  msg += `\n<b>Выберите локацию для настройки пароля:</b>`;
  
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

// Установка пароля для локации
bot.action(/set_pwd_(.+)/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  if (!LOCATIONS[locationId]) {
    await ctx.answerCbQuery('Локация не найдена', { show_alert: true });
    return;
  }
  
  ctx.session.settingType = 'password';
  ctx.session.location = locationId;
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🔑 <b>Установка пароля для "${LOCATIONS[locationId].name}"</b>\n\n` +
    `Отправьте пароль доступа к локации:\n` +
    `<i>• Регистр важен!\n` +
    `• Без пробелов в начале/конце\n` +
    `• Пример: <code>gate2024</code></i>`
  );
});

// ============ МЕНЮ ЗАДАНИЙ ============
bot.action('admin_missions', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const missions = db.getAllMissions();
  
  let msg = `📝 <b>Задания локаций</b>\n\n` +
    `<i>Эти задания игроки видят после ввода пароля доступа</i>\n\n`;
  
  Object.entries(LOCATIONS).forEach(([id, loc]) => {
    const mission = missions.find(m => m.location === id);
    msg += `${mission ? '✅' : '❌'} ${loc.emoji} ${loc.name}\n`;
  });
  
  msg += `\n<b>Выберите локацию для настройки задания:</b>`;
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🚪 Врата', callback_ 'set_mission_gates' },
        { text: '🛡️ Купол', callback_ 'set_mission_dome' }
      ],
      [
        { text: '🪞 Зеркало', callback_ 'set_mission_mirror' },
        { text: '🔮 Камень', callback_ 'set_mission_stone' }
      ],
      [
        { text: '🏠 Хижина', callback_ 'set_mission_hut' },
        { text: '👾 Логово', callback_ 'set_mission_lair' }
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

// Установка задания для локации
bot.action(/set_mission_(.+)/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  if (!LOCATIONS[locationId]) {
    await ctx.answerCbQuery('Локация не найдена', { show_alert: true });
    return;
  }
  
  ctx.session.settingType = 'mission';
  ctx.session.location = locationId;
  ctx.session.step = 'text';
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `📝 <b>Настройка задания для "${LOCATIONS[locationId].name}"</b>\n\n` +
    `Шаг 1/3: Отправьте <b>текст задания</b>:\n` +
    `<i>Пример: "Найди амулет под древним дубом"</i>`
  );
});

// ============ МЕНЮ ПОДСКАЗОК ============
bot.action('admin_hints', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const hintCounts = {};
  Object.keys(LOCATIONS).forEach(loc => {
    hintCounts[loc] = db.getHintsForLocation(loc).length;
  });
  
  let msg = `💡 <b>Подсказки по локациям</b>\n\n` +
    `<i>Игроки могут запросить до 3 подсказок за квест</i>\n\n`;
  
  Object.entries(LOCATIONS).forEach(([id, loc]) => {
    msg += `${loc.emoji} ${loc.name}: ${hintCounts[id]} подсказок\n`;
  });
  
  msg += `\n<b>Выберите действие:</b>`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '➕ Добавить подсказку', callback_ 'add_hint' }],
      [{ text: '🔙 Назад', callback_ 'admin_main' }]
    ]
  };
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
});

// Добавление подсказки — выбор локации
bot.action('add_hint', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🚪 Врата', callback_ 'hint_loc_gates' },
        { text: '🛡️ Купол', callback_ 'hint_loc_dome' }
      ],
      [
        { text: '🪞 Зеркало', callback_ 'hint_loc_mirror' },
        { text: '🔮 Камень', callback_ 'hint_loc_stone' }
      ],
      [
        { text: '🏠 Хижина', callback_ 'hint_loc_hut' },
        { text: '👾 Логово', callback_ 'hint_loc_lair' }
      ],
      [{ text: '🔙 Отмена', callback_ 'admin_hints' }]
    ]
  };
  
  await ctx.replyWithHTML(
    `➕ <b>Добавление подсказки</b>\n\nВыберите локацию:`,
    { reply_markup: keyboard }
  );
  await ctx.answerCbQuery();
});

// Выбор локации для подсказки
bot.action(/hint_loc_(.+)/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  if (!LOCATIONS[locationId]) {
    await ctx.answerCbQuery('Локация не найдена', { show_alert: true });
    return;
  }
  
  ctx.session.settingType = 'hint';
  ctx.session.location = locationId;
  ctx.session.step = 'level';
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🔢 <b>Уровень подсказки для "${LOCATIONS[locationId].name}"</b>\n\n` +
    `Отправьте уровень (1-3):\n` +
    `1️⃣ — Общая подсказка\n` +
    `2️⃣ — Конкретная подсказка\n` +
    `3️⃣ — Детальная подсказка`
  );
});

// ============ СТАТИСТИКА ============
bot.action('admin_stats', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const { totalPlayers, completedPlayers } = db.getStats();
  
  const msg = `📊 <b>Статистика квеста</b>\n\n` +
    `👥 Всего игроков: ${totalPlayers}\n` +
    `🏆 Завершили квест: ${completedPlayers}\n\n` +
    `<i>Статистика обновляется в реальном времени</i>`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔄 Обновить', callback_ 'admin_stats' }],
      [{ text: '🔙 Назад', callback_ 'admin_main' }]
    ]
  };
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
});

// Назад в главное меню
bot.action('admin_main', async (ctx) => {
  if (!ctx.isAdmin) return;
  await ctx.answerCbQuery();
  await showAdminMenu(ctx);
});

// ============ ОБРАБОТКА ТЕКСТА ============
bot.on('text', async (ctx) => {
  if (!ctx.isAdmin || !ctx.session?.settingType) return;
  
  const { settingType, location, step } = ctx.session;
  const text = ctx.message.text.trim();
  
  // Установка пароля
  if (settingType === 'password') {
    if (text.length < 4) {
      await ctx.reply('⚠️ Пароль должен быть не менее 4 символов. Попробуйте ещё раз:');
      return;
    }
    
    db.setPassword(location, text);
    await ctx.replyWithHTML(
      `✅ <b>Пароль установлен!</b>\n\n` +
      `Локация: ${LOCATIONS[location].name}\n` +
      `Пароль: <code>${text}</code>\n\n` +
      `<i>Игроки должны ввести этот пароль для доступа к заданию</i>`
    );
    
    // Очищаем сессию
    delete ctx.session.settingType;
    delete ctx.session.location;
    await showAdminMenu(ctx);
    return;
  }
  
  // Установка задания — шаг 1 (текст)
  if (settingType === 'mission' && step === 'text') {
    ctx.session.missionText = text;
    ctx.session.step = 'answer';
    await ctx.replyWithHTML(
      `📝 <b>Настройка задания для "${LOCATIONS[location].name}"</b>\n\n` +
      `Шаг 2/3: Отправьте <b>правильный ответ</b>:\n` +
      `<i>Пример: "дуб2024"</i>`
    );
    return;
  }
  
  // Установка задания — шаг 2 (ответ)
  if (settingType === 'mission' && step === 'answer') {
    ctx.session.missionAnswer = text;
    ctx.session.step = 'image';
    await ctx.replyWithHTML(
      `📝 <b>Настройка задания для "${LOCATIONS[location].name}"</b>\n\n` +
      `Шаг 3/3: Отправьте <b>URL изображения</b> или "-" для пропуска:\n` +
      `<i>Рекомендуется: 800x600px, JPG/PNG</i>`
    );
    return;
  }
  
  // Установка задания — шаг 3 (изображение)
  if (settingType === 'mission' && step === 'image') {
    const imageUrl = text !== '-' ? text : null;
    db.setMission(location, ctx.session.missionText, text, imageUrl);
    
    await ctx.replyWithHTML(
      `✅ <b>Задание сохранено!</b>\n\n` +
      `Локация: ${LOCATIONS[location].name}\n` +
      `Текст: ${ctx.session.missionText.substring(0, 50)}...\n` +
      `Ответ: <code>${ctx.session.missionAnswer}</code>`
    );
    
    // Очищаем сессию
    delete ctx.session.settingType;
    delete ctx.session.location;
    delete ctx.session.step;
    delete ctx.session.missionText;
    delete ctx.session.missionAnswer;
    await showAdminMenu(ctx);
    return;
  }
  
  // Установка подсказки — шаг 1 (уровень)
  if (settingType === 'hint' && step === 'level') {
    const level = parseInt(text);
    if (isNaN(level) || level < 1 || level > 3) {
      await ctx.reply('❌ Уровень должен быть от 1 до 3. Попробуйте ещё раз:');
      return;
    }
    
    ctx.session.hintLevel = level;
    ctx.session.step = 'text';
    await ctx.replyWithHTML(
      `✏️ <b>Подсказка для "${LOCATIONS[location].name}" (уровень ${level})</b>\n\n` +
      `Отправьте текст подсказки:`
    );
    return;
  }
  
  // Установка подсказки — шаг 2 (текст)
  if (settingType === 'hint' && step === 'text') {
    db.createHint(location, ctx.session.hintLevel, text);
    
    await ctx.replyWithHTML(
      `✅ <b>Подсказка создана!</b>\n\n` +
      `Локация: ${LOCATIONS[location].name}\n` +
      `Уровень: ${ctx.session.hintLevel}\n` +
      `Текст: ${text}`
    );
    
    // Очищаем сессию
    delete ctx.session.settingType;
    delete ctx.session.location;
    delete ctx.session.step;
    delete ctx.session.hintLevel;
    await showAdminMenu(ctx);
    return;
  }
});

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error(`⚠️ Ошибка ${ctx.updateType}:`, err.message);
});

// ==================== ЗАПУСК СИСТЕМЫ ====================
// Запуск HTTP сервера
server.listen(PORT, () => {
  console.log(`✅ HTTP сервер запущен на порту ${PORT}`);
  console.log(`🌐 Эндпоинты:`);
  console.log(`   POST /check-password  - проверка пароля доступа`);
  console.log(`   POST /get-mission     - получение задания`);
  console.log(`   POST /check-answer    - проверка ответа на задание`);
  console.log(`   POST /request-hint    - запрос подсказки`);
});

// Запуск бота
bot.launch();
console.log('✅ Telegram бот запущен');
console.log('🔧 Админ ID:', ADMIN_USER_IDS[0]);
console.log('🌐 Фронтенд URL:', FRONTEND_URL);
console.log('💾 База данных: quest.db (SQLite)');

// Остановка при завершении процесса
const stop = () => {
  console.log('🛑 Остановка системы...');
  bot.stop('SIGTERM');
  server.close(() => {
    console.log('✅ Система остановлена');
    process.exit(0);
  });
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
