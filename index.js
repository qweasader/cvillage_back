// index.js — упрощённая регистрация: 1 игрок = 1 команда
import { Telegraf } from 'telegraf';
import http from 'http';
import { URL } from 'url';
import { QuestDatabase } from './database.js';
import 'dotenv/config';

// ==================== КОНФИГУРАЦИЯ ====================
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL;
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

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

  // ============ ИЗВЛЕЧЕНИЕ USER ID ИЗ INITDATA ============
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
      message: 'Сначала зарегистрируйтесь в боте! Напишите /start',
      requiresRegistration: true
    }));
    return;
  }

  const team = db.getTeamByPlayerId(userId);
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

  // ============ ОПРЕДЕЛЕНИЕ ТЕКУЩЕЙ ЛОКАЦИИ ПО МАРШРУТУ ============
  const currentLocation = db.getCurrentLocationForTeam(team.id);
  const unlocked = JSON.parse(team.unlocked_locations || '["gates"]');
  
  console.log(`\n📍 Текущая локация команды ${team.id}: "${currentLocation}"`);
  console.log(`   Разблокировано: ${unlocked.join(', ')}`);
  console.log(`   Пройдено: ${JSON.parse(team.completed_locations || '[]').length}/6`);

  // Парсинг тела
  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', async () => {
    try {
      const data = body ? JSON.parse(body) : {};

      // ============ ПРОВЕРКА ПАРОЛЯ ДЛЯ ТЕКУЩЕЙ ЛОКАЦИИ ============
      if (pathname === '/check-password' && req.method === 'POST') {
        const { password } = data;
        
        console.log(`\n🔐 Проверка пароля для текущей локации "${currentLocation}"`);
        
        if (!password) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, message: 'Не указан пароль' }));
          return;
        }
        
        if (!unlocked.includes(currentLocation)) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
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
            'Content-Type': 'application/json',
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
        
        console.log(`   Результат: ${isCorrect ? '✅ ВЕРНО' : '❌ НЕВЕРНО'}`);
        
        if (isCorrect) {
          db.logEvent('location_unlocked', team.id, currentLocation, { userId });
          res.writeHead(200, {
            'Content-Type': 'application/json',
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
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: false, 
            message: 'Неверный пароль! Проверьте написание и попробуйте снова.'
          }));
        }
        return;
      }

      // ============ ПОЛУЧЕНИЕ ЗАДАНИЯ ДЛЯ ТЕКУЩЕЙ ЛОКАЦИИ ============
      if (pathname === '/get-mission' && req.method === 'POST') {
        console.log(`\n📜 Получение задания для локации "${currentLocation}"`);
        
        if (!unlocked.includes(currentLocation)) {
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
        
        const mission = db.getMission(currentLocation);
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
        
        res.writeHead(200, {
          'Content-Type': 'application/json',
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
        return;
      }

      // ============ ПРОВЕРКА ОТВЕТА ДЛЯ ТЕКУЩЕЙ ЛОКАЦИИ ============
      if (pathname === '/check-answer' && req.method === 'POST') {
        const { answer } = data;
        
        console.log(`\n✅ Проверка ответа для локации "${currentLocation}"`);
        
        if (!answer) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ success: false, message: 'Не указан ответ' }));
          return;
        }
        
        const mission = db.getMission(currentLocation);
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
          db.completeLocationForTeam(team.id, currentLocation);
          db.logEvent('location_completed', team.id, currentLocation, { userId });
          
          const updatedTeam = db.getTeamById(team.id);
          const completed = JSON.parse(updatedTeam.completed_locations || '[]');
          const isQuestComplete = completed.length >= 6;
          const nextLocation = db.getNextLocationForTeam(team.id);
          
          res.writeHead(200, {
            'Content-Type': 'application/json',
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

      // ============ ЗАПРОС ПОДСКАЗКИ ДЛЯ ТЕКУЩЕЙ ЛОКАЦИИ ============
      if (pathname === '/request-hint' && req.method === 'POST') {
        const { hintLevel = 1 } = data;
        
        console.log(`\n💡 Запрос подсказки (уровень ${hintLevel}) для локации "${currentLocation}"`);
        
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
        
        const hint = db.getHint(currentLocation, hintLevel);
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
        
        // Используем подсказку на уровне команды
        const teamRow = db.getTeamById(team.id);
        if (teamRow.hints_used < 3) {
          db.db.prepare('UPDATE teams SET hints_used = hints_used + 1, last_activity = CURRENT_TIMESTAMP WHERE id = ?')
            .run(team.id);
        }
        
        db.logEvent('hint_used', team.id, currentLocation, { userId, level: hintLevel });
        
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
          location: currentLocation
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

// ==================== TELEGRAM БОТ — УПРОЩЁННАЯ РЕГИСТРАЦИЯ ====================
bot.use((ctx, next) => {
  ctx.isAdmin = ADMIN_USER_IDS.includes(ctx.from?.id);
  ctx.session = getSession(ctx.from?.id);
  return next();
});

// Команда /start — МГНОВЕННАЯ РЕГИСТРАЦИЯ
bot.start(async (ctx) => {
  const player = db.getPlayer(ctx.from.id);
  const isRegistered = player && player.is_registered;
  
  // Если уже зарегистрирован — показываем меню квеста
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
            [{ text: '📊 Статистика', callback_data:'team_stats' }],
            [{ text: '🔧 Админ-панель', callback_data:'admin_panel' }]
          ].filter(btn => !ctx.isAdmin || btn[0].text !== '🔧 Админ-панель' || ctx.isAdmin)
        }
      }
    );
    return;
  }
  
  // Новый игрок — МГНОВЕННАЯ РЕГИСТРАЦИЯ без кодов команды!
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

// Админ-панель доступна только администраторам
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

// Статистика команды
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
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `📊 <b>Статистика вашей команды</b>\n\n` +
    `🛡️ Название: ${team.name}\n` +
    `✅ Пройдено локаций: ${completed}/6\n` +
    `🔓 Открыто локаций: ${unlocked}/6\n` +
    `💡 Осталось подсказок: ${hintsLeft}/3\n\n` +
    `<b>Ваш маршрут:</b>\n${routeText}`
  );
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
  const currentLocation = db.locationGraph[nextLocationIndex] || 'gates';
  
  const hintLevel = team.hints_used + 1;
  const hint = await db.getHint(currentLocation, hintLevel);
  
  if (!hint) {
    await ctx.reply('🤔 Подсказка для текущей локации не настроена.');
    return;
  }
  
  // Используем подсказку
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

// ... остальные обработчики админ-панели без изменений (полный код идентичен предыдущей версии) ...

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

// Обработчики админ-панели (без изменений)
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
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
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
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
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
      await showAdminMenu(ctx);
      return;
    }
    
    if (settingType === 'mission' && step === 'text') {
      ctx.session.missionText = text;
      ctx.session.step = 'answer';
      await ctx.replyWithHTML(
        `📝 <b>Настройка задания для "${db.locationGraph[location].name}"</b>\n\n` +
        `Шаг 2/3: Отправьте <b>правильный ответ</b>:\n` +
        `<i>Пример: "дуб2024"</i>`
      );
      return;
    }
    
    if (settingType === 'mission' && step === 'answer') {
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
      const imageUrl = text !== '-' ? text : null;
      db.setMission(location, ctx.session.missionText, text, imageUrl);
      
      await ctx.replyWithHTML(
        `✅ <b>Задание сохранено!</b>\n\n` +
        `Локация: ${db.locationGraph[location].name}\n` +
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
      await showAdminMenu(ctx);
      return;
    }
  }
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
  console.log(`   POST /check-password     - проверка пароля (без указания локации!)`);
  console.log(`   POST /get-mission        - получение задания (без указания локации!)`);
  console.log(`   POST /check-answer       - проверка ответа (без указания локации!)`);
  console.log(`   POST /request-hint       - запрос подсказки (без указания локации!)`);
  console.log(`   GET  /health             - health check`);
  
  await setupWebhook();
  bot.webhookCallback(`/${WEBHOOK_SECRET}`, server);
  
  console.log('✅ Telegram бот готов к работе');
  console.log('🔧 Админ ID:', ADMIN_USER_IDS[0]);
  console.log('🌐 Фронтенд URL:', FRONTEND_URL);
  console.log('✨ Упрощённая регистрация: 1 игрок = 1 команда с уникальным маршрутом!');
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
