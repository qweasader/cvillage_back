// index.js — исправленная версия с надежной проверкой паролей
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
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'quest-bot-webhook-secret-1234567890';

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

// ==================== HTTP СЕРВЕР С ВЕБХУКАМИ ====================
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

      // ПРОВЕРКА ПАРОЛЯ — ИСПРАВЛЕНО: НАДЕЖНАЯ НОРМАЛИЗАЦИЯ
      if (pathname === '/check-password' && req.method === 'POST') {
        const { location, password } = data;
        
        if (!location || !password) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, message: 'Не указаны локация или пароль' }));
          return;
        }

        // Проверяем, что это следующая локация для команды
        const unlocked = JSON.parse(team.unlocked_locations || '["gates"]');
        const completed = JSON.parse(team.completed_locations || '[]');
        const nextLocationIndex = completed.length;
        const expectedLocation = ALL_LOCATIONS[nextLocationIndex] || 'gates';
        
        if (location !== expectedLocation) {
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

        // Получаем пароль из БД
        const passwordData = db.getPassword(location);
        
        if (!passwordData) {
          console.warn(`⚠️ Пароль для локации ${location} не настроен`);
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

        // Нормализуем введенный пароль (так же, как при сохранении)
        const cleanInput = password.trim();
        const normalizedInput = cleanInput.toLowerCase().replace(/[^a-z0-9_]/g, '');
        
        // Сравниваем нормализованные версии
        const isCorrect = normalizedInput === passwordData.normalized;

        // ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ ДЛЯ ОТЛАДКИ
        console.log(`🔑 Проверка пароля для локации "${location}":`);
        console.log(`   Введено (оригинал): "${cleanInput}"`);
        console.log(`   Введено (нормализ.): "${normalizedInput}"`);
        console.log(`   В БД (оригинал): "${passwordData.original}"`);
        console.log(`   В БД (нормализ.): "${passwordData.normalized}"`);
        console.log(`   Результат: ${isCorrect ? '✅ ВЕРНО' : '❌ НЕВЕРНО'}`);

        if (isCorrect) {
          db.logEvent('location_unlocked', team.id, location, { userId });
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
          
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Неверный пароль! Проверьте написание и попробуйте снова.',
            debug: {
              inputNormalized: normalizedInput,
              expectedNormalized: passwordData.normalized
            }
          }));
        }
        return;
      }

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

        // Нормализация ответа (без учета регистра и лишних пробелов)
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

// ==================== TELEGRAM БОТ ====================
bot.use((ctx, next) => {
  ctx.isAdmin = ADMIN_USER_IDS.includes(ctx.from?.id);
  ctx.session = getSession(ctx.from?.id);
  return next();
});

bot.start(async (ctx) => {
  const player = db.getPlayer(ctx.from.id);
  const isRegistered = player && player.is_registered;
  
  const adminButton = ctx.isAdmin ? [{ text: '🔧 Админ-панель', callback_data:'admin_panel' }] : [];
  
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
            [{ text: '🚀 Начать квест', web_app: { url: `${FRONTEND_URL}?team=${team.code}` } }],
            [{ text: '📊 Статистика команды', callback_data:'team_stats' }],
            [{ text: '👥 Состав команды', callback_data:'team_members' }],
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
            [{ text: '🔧 Админ-панель', callback_data:'admin_panel' }],
            [{ text: '🆕 Создать команду', callback_data:'create_new_team' }],
            [{ text: '❓ Как создать команду?', callback_data:'how_to_create' }]
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
          [{ text: '🆕 Создать новую команду', callback_data:'create_new_team' }],
          [{ text: '❓ Как создать команду?', callback_data:'how_to_create' }]
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
          [{ text: '🚀 Начать квест', web_app: { url: `${FRONTEND_URL}?team=${teamCode}` } }],
          [{ text: '📊 Статистика команды', callback_data:'team_stats' }],
          [{ text: '🔧 Админ-панель', callback_data:'admin_panel' }]
        ]
      }
    }
  );
  
  if (ctx.session) {
    delete ctx.session.registerStep;
    delete ctx.session.teamCode;
  }
});

bot.action('how_to_create', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🆕 <b>Как создать команду:</b>\n\n` +
    `1️⃣ Нажмите кнопку "🆕 Создать новую команду"\n` +
    `2️⃣ Получите уникальный код (например: <code>XYZ789</code>)\n` +
    `3️⃣ Отправьте код своим 2 товарищам\n` +
    `4️⃣ Каждый участник вводит этот код при регистрации\n\n` +
    `💡 <b>Важно:</b>\n` +
    `- В команде максимум 3 игрока\n` +
    `- Код чувствителен к регистру (лучше использовать заглавные буквы)\n` +
    `- Сохраните код — он понадобится для входа в квест`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Назад', callback_data:'back_to_register' }]
        ]
      }
    }
  );
});

bot.action('back_to_register', async (ctx) => {
  ctx.session.registerStep = 'team_code';
  await ctx.answerCbQuery();
  
  if (ctx.isAdmin) {
    await ctx.editMessageText(
      `👋 <b>Добро пожаловать, Администратор!</b>\n\n` +
      `🛡️ Вы можете:\n` +
      `• Настроить квест через админ-панель\n` +
      `• Создать команду и пройти квест как игрок`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔧 Админ-панель', callback_data:'admin_panel' }],
            [{ text: '🆕 Создать команду', callback_data:'create_new_team' }],
            [{ text: '❓ Как создать команду?', callback_data:'how_to_create' }]
          ]
        }
      }
    );
  } else {
    await ctx.editMessageText(
      `👋 <b>Добро пожаловать в "Защиту Кибердеревни"!</b>\n\n` +
      `👾 Это <b>командный квест</b> для групп по 3 человека.\n\n` +
      `<b>Как зарегистрироваться:</b>\n` +
      `1️⃣ Получите код команды у капитана\n` +
      `2️⃣ Введите код ниже (6 символов)\n` +
      `3️⃣ Укажите ваше имя в команде\n\n` +
      `<i>Пример кода: ABC123</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🆕 Создать новую команду', callback_data:'create_new_team' }],
            [{ text: '❓ Как создать команду?', callback_data:'how_to_create' }]
          ]
        }
      }
    );
  }
});

bot.on('text', async (ctx) => {
  if (ctx.session?.registerStep === 'team_code') {
    const teamCode = ctx.message.text.trim().toUpperCase();
    
    if (teamCode.length < 4) {
      await ctx.reply('⚠️ Код команды должен быть не менее 4 символов. Попробуйте ещё раз:');
      return;
    }
    
    let team = db.getTeamByCode(teamCode);
    if (!team) {
      team = db.createTeam(teamCode, `Команда ${teamCode}`);
      await ctx.replyWithHTML(
        `🆕 <b>Создана новая команда!</b>\n\n` +
        `🔑 Код: <code>${teamCode}</code>\n` +
        `Теперь укажите ваше имя в команде:`
      );
    } else {
      const members = db.getTeamMembers(team.id);
      if (members.length >= 3) {
        await ctx.replyWithHTML(
          `🚫 <b>Команда заполнена!</b>\n\n` +
          `В команде "${team.name}" уже 3 игрока.\n` +
          `Попросите капитана создать новую команду или выберите другой код.`
        );
        return;
      }
      
      await ctx.replyWithHTML(
        `✅ <b>Команда найдена!</b>\n\n` +
        `Название: <b>${team.name}</b>\n` +
        `Участников: ${members.length}/3\n\n` +
        `Теперь укажите ваше имя в команде:`
      );
    }
    
    ctx.session.teamCode = teamCode;
    ctx.session.registerStep = 'player_name';
    return;
  }
  
  if (ctx.session?.registerStep === 'player_name') {
    const playerName = ctx.message.text.trim();
    
    if (playerName.length < 2) {
      await ctx.reply('⚠️ Имя должно быть не менее 2 символов. Попробуйте ещё раз:');
      return;
    }
    
    const { player, team } = db.registerPlayer(ctx.from.id, ctx.session.teamCode, playerName);
    const members = db.getTeamMembers(team.id);
    
    delete ctx.session.registerStep;
    delete ctx.session.teamCode;
    
    const adminButton = ctx.isAdmin ? [{ text: '🔧 Админ-панель', callback_data:'admin_panel' }] : [];
    
    await ctx.replyWithHTML(
      `✅ <b>Регистрация завершена!</b>\n\n` +
      `👤 <b>Игрок:</b> ${playerName}\n` +
      `🛡️ <b>Команда:</b> ${team.name} (<code>${team.code}</code>)\n` +
      `👥 <b>Состав:</b> ${members.length}/3 игрока\n\n` +
      `Готовы спасти Кибердеревню?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Начать квест', web_app: { url: `${FRONTEND_URL}?team=${team.code}` } }],
            [{ text: '📊 Статистика команды', callback_data:'team_stats' }],
            ...adminButton
          ]
        }
      }
    );
    return;
  }
  
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
        `Локация: ${LOCATIONS[location].name}\n` +
        `Пароль: <code>${text}</code>\n\n` +
        `<i>Игроки должны ввести этот пароль для доступа к заданию</i>`
      );
      
      delete ctx.session.settingType;
      delete ctx.session.location;
      await showAdminMenu(ctx);
      return;
    }
    
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
    
    if (settingType === 'mission' && step === 'image') {
      const imageUrl = text !== '-' ? text : null;
      db.setMission(location, ctx.session.missionText, text, imageUrl);
      
      await ctx.replyWithHTML(
        `✅ <b>Задание сохранено!</b>\n\n` +
        `Локация: ${LOCATIONS[location].name}\n` +
        `Текст: ${ctx.session.missionText.substring(0, 50)}...\n` +
        `Ответ: <code>${ctx.session.missionAnswer}</code>`
      );
      
      delete ctx.session.settingType;
      delete ctx.session.location;
      delete ctx.session.step;
      delete ctx.session.missionText;
      delete ctx.session.missionAnswer;
      await showAdminMenu(ctx);
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
        `✏️ <b>Подсказка для "${LOCATIONS[location].name}" (уровень ${level})</b>\n\n` +
        `Отправьте текст подсказки:`
      );
      return;
    }
    
    if (settingType === 'hint' && step === 'text') {
      db.createHint(location, ctx.session.hintLevel, text);
      
      await ctx.replyWithHTML(
        `✅ <b>Подсказка создана!</b>\n\n` +
        `Локация: ${LOCATIONS[location].name}\n` +
        `Уровень: ${ctx.session.hintLevel}\n` +
        `Текст: ${text}`
      );
      
      delete ctx.session.settingType;
      delete ctx.session.location;
      delete ctx.session.step;
      delete ctx.session.hintLevel;
      await showAdminMenu(ctx);
      return;
    }
  }
});

bot.action('team_stats', async (ctx) => {
  const player = db.getPlayer(ctx.from.id);
  if (!player || !player.is_registered) {
    await ctx.answerCbQuery('Сначала зарегистрируйтесь!', { show_alert: true });
    return;
  }
  
  const team = db.getTeamById(player.team_id);
  const members = db.getTeamMembers(team.id);
  const completed = JSON.parse(team.completed_locations || '[]').length;
  const unlocked = JSON.parse(team.unlocked_locations || '["gates"]').length;
  const hintsLeft = 3 - team.hints_used;
  
  let membersList = '';
  members.forEach((m, i) => {
    membersList += `\n${i + 1}. ${m.first_name} ${m.last_name ? `(${m.last_name})` : ''}`;
  });
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `📊 <b>Статистика команды "${team.name}"</b>\n\n` +
    `🔑 Код: <code>${team.code}</code>\n` +
    `👥 Состав: ${members.length}/3${membersList}\n\n` +
    `✅ Пройдено локаций: ${completed}/6\n` +
    `🔓 Открыто локаций: ${unlocked}/6\n` +
    `💡 Осталось подсказок: ${hintsLeft}/3`
  );
});

bot.action('team_members', async (ctx) => {
  const player = db.getPlayer(ctx.from.id);
  if (!player || !player.is_registered) {
    await ctx.answerCbQuery('Сначала зарегистрируйтесь!', { show_alert: true });
    return;
  }
  
  const team = db.getTeamById(player.team_id);
  const members = db.getTeamMembers(team.id);
  
  let membersText = `👥 <b>Состав команды "${team.name}"</b>\n\n`;
  members.forEach((m, i) => {
    const isYou = m.id === String(ctx.from.id) ? ' (вы)' : '';
    membersText += `${i + 1}. ${m.first_name}${isYou}\n`;
  });
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(membersText);
});

bot.command('stats', async (ctx) => {
  const player = await db.getPlayer(ctx.from.id);
  if (!player || !player.is_registered) {
    await ctx.reply('Сначала зарегистрируйтесь командой /start');
    return;
  }
  
  const team = db.getTeamById(player.team_id);
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
  
  const team = db.getTeamById(player.team_id);
  if (team.hints_used >= 3) {
    await ctx.reply('🚫 У вашей команды закончились подсказки!');
    return;
  }
  
  const completed = JSON.parse(team.completed_locations || '[]');
  const nextLocationIndex = completed.length;
  const currentLocation = ALL_LOCATIONS[nextLocationIndex] || 'gates';
  
  const hintLevel = team.hints_used + 1;
  const hint = await db.getHint(currentLocation, hintLevel);
  
  if (!hint) {
    await ctx.reply('🤔 Подсказка для текущей локации не настроена.');
    return;
  }
  
  db.useHintForTeam(team.id);
  await db.logEvent('hint_used', team.id, currentLocation, { userId: ctx.from.id, level: hintLevel });
  
  const hintsLeft = 3 - (team.hints_used + 1);
  
  await ctx.replyWithHTML(
    `💡 <b>Подсказка для "${LOCATIONS[currentLocation].name}"</b>\n\n` +
    `${hint.text}\n\n` +
    `Осталось подсказок у команды: ${hintsLeft}/3`
  );
});

async function showAdminMenu(ctx) {
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
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
});

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
    `<i>• Регистр НЕ важен (система игнорирует его)\n` +
    `• Без пробелов в начале/конце\n` +
    `• Пример: <code>gate2024</code></i>`
  );
});

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
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
});

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
      [{ text: '➕ Добавить подсказку', callback_data:'add_hint' }],
      [{ text: '🔙 Назад', callback_data:'admin_main' }]
    ]
  };
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
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
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
});

bot.action('admin_main', async (ctx) => {
  if (!ctx.isAdmin) return;
  await ctx.answerCbQuery();
  await showAdminMenu(ctx);
});

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
  console.log(`   POST /${WEBHOOK_SECRET}   - обработка вебхуков Telegram`);
  console.log(`   POST /check-password     - проверка пароля доступа`);
  console.log(`   POST /get-mission        - получение задания`);
  console.log(`   POST /check-answer       - проверка ответа`);
  console.log(`   POST /request-hint       - запрос подсказки`);
  console.log(`   GET  /health             - health check`);
  
  await setupWebhook();
  bot.webhookCallback(`/${WEBHOOK_SECRET}`, server);
  
  console.log('✅ Telegram бот готов к работе через вебхуки');
  console.log('🔧 Админ ID:', ADMIN_USER_IDS[0]);
  console.log('🌐 Фронтенд URL:', FRONTEND_URL);
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
