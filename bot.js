// bot.js — полностью рабочая админ-панель с колбэками
import { Telegraf, session, Markup } from 'telegraf';
import sqlite3 from 'better-sqlite3';
import 'dotenv/config';

// ==================== КОНФИГУРАЦИЯ ====================
const ADMIN_USER_IDS = [
  131918408
];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://qweasader.github.io/cybervillage_defend/';
const MAX_HINTS = 3;

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('❌ TELEGRAM_BOT_TOKEN не установлен! Добавьте его в переменные окружения Railway.');
}

if (ADMIN_USER_IDS.length === 0 || ADMIN_USER_IDS[0] === 131918408) {
  throw new Error('❌ ADMIN_USER_IDS не настроен! Замените 123456789 на ваш реальный Telegram ID в начале файла bot.js');
}

// ==================== БАЗА ДАННЫХ ====================
const sqlite = sqlite3('database.sqlite');

function initDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT NOT NULL,
      last_name TEXT,
      team_id TEXT,
      hints_used INTEGER DEFAULT 0 CHECK (hints_used <= ${MAX_HINTS}),
      completed_locations TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      location TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      answer TEXT NOT NULL,
      image_url TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS location_passwords (
      location TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS hints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location TEXT NOT NULL,
      hint_level INTEGER NOT NULL CHECK (hint_level BETWEEN 1 AND 3),
      text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(location, hint_level)
    )
  `);
  
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      user_id INTEGER,
      location TEXT,
      data TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_players_id ON players(id)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id)');
  console.log('✅ Database initialized');
}

const dbService = {
  getPlayer: (userId) => sqlite.prepare('SELECT * FROM players WHERE id = ?').get(userId),
  
  createOrUpdatePlayer(userId, data) {
    const existing = this.getPlayer(userId);
    if (existing) {
      sqlite.prepare(`
        UPDATE players 
        SET username = ?, first_name = ?, last_name = ?, team_id = ?, last_activity = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(data.username || null, data.first_name || '', data.last_name || null, data.team_id || null, userId);
    } else {
      sqlite.prepare(`
        INSERT INTO players (id, username, first_name, last_name, team_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, data.username || null, data.first_name || '', data.last_name || null, data.team_id || null);
    }
    return this.getPlayer(userId);
  },
  
  useHint(userId) {
    const player = this.getPlayer(userId);
    if (!player) throw new Error('Player not found');
    if (player.hints_used >= MAX_HINTS) return false;
    sqlite.prepare('UPDATE players SET hints_used = hints_used + 1 WHERE id = ?').run(userId);
    return true;
  },
  
  completeLocation(userId, locationId) {
    const player = this.getPlayer(userId);
    if (!player) throw new Error('Player not found');
    let completed = JSON.parse(player.completed_locations || '[]');
    if (!completed.includes(locationId)) {
      completed.push(locationId);
      sqlite.prepare('UPDATE players SET completed_locations = ? WHERE id = ?').run(JSON.stringify(completed), userId);
    }
  },
  
  getMission: (location) => sqlite.prepare('SELECT * FROM missions WHERE location = ?').get(location),
  
  setMission(location, missionData) {
    const existing = this.getMission(location);
    if (existing) {
      sqlite.prepare(`
        UPDATE missions 
        SET text = ?, answer = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE location = ?
      `).run(missionData.text, missionData.answer, missionData.imageUrl || null, location);
    } else {
      sqlite.prepare(`
        INSERT INTO missions (location, text, answer, image_url)
        VALUES (?, ?, ?, ?)
      `).run(location, missionData.text, missionData.answer, missionData.imageUrl || null);
    }
    return this.getMission(location);
  },
  
  getAllMissions: () => sqlite.prepare('SELECT * FROM missions ORDER BY location').all(),
  
  getPassword: (location) => {
    const row = sqlite.prepare('SELECT password FROM location_passwords WHERE location = ?').get(location);
    return row ? row.password : null;
  },
  
  setPassword(location, password) {
    const existing = sqlite.prepare('SELECT 1 FROM location_passwords WHERE location = ?').get(location);
    if (existing) {
      sqlite.prepare('UPDATE location_passwords SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE location = ?').run(password, location);
    } else {
      sqlite.prepare('INSERT INTO location_passwords (location, password) VALUES (?, ?)').run(location, password);
    }
  },
  
  getAllPasswords: () => sqlite.prepare('SELECT * FROM location_passwords').all(),
  
  getHint(location, hintLevel) {
    return sqlite.prepare(`
      SELECT * FROM hints 
      WHERE location = ? AND hint_level <= ?
      ORDER BY hint_level DESC
      LIMIT 1
    `).get(location, hintLevel);
  },
  
  createHint(hintData) {
    sqlite.prepare('DELETE FROM hints WHERE location = ? AND hint_level = ?').run(hintData.location, hintData.hintLevel);
    sqlite.prepare(`INSERT INTO hints (location, hint_level, text) VALUES (?, ?, ?)`).run(hintData.location, hintData.hintLevel, hintData.text);
    return this.getHint(hintData.location, hintData.hintLevel);
  },
  
  getHintsForLocation: (location) => sqlite.prepare('SELECT * FROM hints WHERE location = ? ORDER BY hint_level').all(location),
  
  logEvent(eventType, userId = null, location = null, eventData = {}) {
    sqlite.prepare(`INSERT INTO events (type, user_id, location, data) VALUES (?, ?, ?, ?)`).run(eventType, userId, location, JSON.stringify(eventData));
  },
  
  getAdminStats() {
    const totalPlayers = sqlite.prepare('SELECT COUNT(*) as count FROM players').get().count;
    const completedPlayers = sqlite.prepare(`SELECT COUNT(*) as count FROM players WHERE json_array_length(completed_locations) >= 6`).get().count;
    const recentEvents = sqlite.prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT 10`).all();
    return { totalPlayers, completedPlayers, recentEvents };
  }
};

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
initDatabase();

// ==================== БОТ ====================
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
bot.use(session());
bot.use((ctx, next) => {
  ctx.isAdmin = ADMIN_USER_IDS.includes(ctx.from?.id);
  return next();
});

const LOCATIONS = {
  gates: { name: 'Врата Кибердеревни', emoji: '🚪', order: 1 },
  dome: { name: 'Купол Защиты', emoji: '🛡️', order: 2 },
  mirror: { name: 'Зеркало Истины', emoji: '🪞', order: 3 },
  stone: { name: 'Камень Пророчеств', emoji: '🔮', order: 4 },
  hut: { name: 'Хижина Хранителя', emoji: '🏠', order: 5 },
  lair: { name: 'Логово Вируса', emoji: '👾', order: 6 }
};

// Команда /start
bot.start(async (ctx) => {
  await dbService.createOrUpdatePlayer(ctx.from.id, {
    username: ctx.from.username,
    first_name: ctx.from.first_name,
    last_name: ctx.from.last_name
  });
  
  await ctx.replyWithHTML(
    `👋 <b>Добро пожаловать в "Защиту Кибердеревни"!</b>\n\n` +
    `👾 Вирус "Тень Сети" атакует нашу деревню!\n` +
    `🛡️ Твоя миссия — пройти 6 локаций и собрать все амулеты защиты.\n\n` +
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
  await dbService.logEvent('bot_start', ctx.from.id);
});

// Команда /stats
bot.command('stats', async (ctx) => {
  const player = await dbService.getPlayer(ctx.from.id);
  if (!player) {
    await ctx.reply('Сначала начни игру командой /start');
    return;
  }
  const completed = JSON.parse(player.completed_locations || '[]').length;
  const hintsLeft = MAX_HINTS - player.hints_used;
  await ctx.replyWithHTML(
    `📊 <b>Твоя статистика</b>\n\n` +
    `👤 Игрок: ${player.first_name || 'Неизвестно'}\n` +
    `✅ Пройдено локаций: ${completed}/6\n` +
    `💡 Осталось подсказок: ${hintsLeft}/${MAX_HINTS}`
  );
  await dbService.logEvent('stats_viewed', ctx.from.id);
});

// Команда /hint
bot.command('hint', async (ctx) => {
  const player = await dbService.getPlayer(ctx.from.id);
  if (!player) {
    await ctx.reply('Сначала начни игру командой /start');
    return;
  }
  if (player.hints_used >= MAX_HINTS) {
    await ctx.reply('🚫 У тебя закончились подсказки!');
    return;
  }
  const allLocations = Object.entries(LOCATIONS).sort((a, b) => a[1].order - b[1].order).map(([id]) => id);
  const completed = JSON.parse(player.completed_locations || '[]');
  const currentLocation = allLocations.find(loc => !completed.includes(loc)) || allLocations[0];
  const hintLevel = player.hints_used + 1;
  const hint = await dbService.getHint(currentLocation, hintLevel);
  if (!hint) {
    await ctx.reply('🤔 Подсказка не настроена. Обратись к организаторам.');
    return;
  }
  await dbService.useHint(ctx.from.id);
  await dbService.logEvent('hint_used', ctx.from.id, currentLocation, { hint_level: hintLevel, hint_id: hint.id });
  const hintsLeft = MAX_HINTS - (player.hints_used + 1);
  await ctx.replyWithHTML(
    `💡 <b>Подсказка для "${LOCATIONS[currentLocation].name}"</b>\n\n` +
    `${hint.text}\n\n` +
    `Осталось подсказок: ${hintsLeft}/${MAX_HINTS}`
  );
});

// Команда /admin
bot.command('admin', async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.replyWithHTML(
      `🚫 <b>Доступ запрещён</b>\n\n` +
      `Твой ID: <code>${ctx.from.id}</code>\n` +
      `Администраторы: ${ADMIN_USER_IDS.join(', ')}`
    );
    await dbService.logEvent('admin_access_denied', ctx.from.id);
    return;
  }
  await showAdminDashboard(ctx);
  await dbService.logEvent('admin_dashboard_viewed', ctx.from.id);
});

// Админ-панель
async function showAdminDashboard(ctx) {
  const [missions, passwords] = await Promise.all([dbService.getAllMissions(), dbService.getAllPasswords()]);
  const hintsCount = dbService.getHintsForLocation('gates').length + 
                     dbService.getHintsForLocation('dome').length +
                     dbService.getHintsForLocation('mirror').length +
                     dbService.getHintsForLocation('stone').length +
                     dbService.getHintsForLocation('hut').length +
                     dbService.getHintsForLocation('lair').length;
  
  let message = `🔧 <b>Админ-панель квеста</b>\n\n`;
  message += `✅ Заданий настроено: ${missions.length}/6\n`;
  message += `🔑 Паролей задано: ${passwords.length}/6\n`;
  message += `💡 Подсказок создано: ${hintsCount}\n\n`;
  message += `<b>Выбери раздел для управления:</b>`;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Задания', 'admin_missions')],
    [Markup.button.callback('🔑 Пароли локаций', 'admin_passwords')],
    [Markup.button.callback('💡 Подсказки', 'admin_hints')],
    [Markup.button.callback('📊 Статистика', 'admin_stats')]
  ]);
  
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(message, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } catch (e) {
      // Если сообщение не изменилось, игнорируем ошибку
      if (!e.description?.includes('message is not modified')) {
        console.error('Edit message error:', e);
      }
    }
  } else {
    await ctx.reply(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }
}

// ============ ОБРАБОТЧИКИ КОЛБЭКОВ ============

// Главное меню
bot.action('admin_dashboard', async (ctx) => {
  if (!ctx.isAdmin) return;
  await ctx.answerCbQuery();
  await showAdminDashboard(ctx);
});

// Раздел "Задания"
bot.action('admin_missions', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const missions = await dbService.getAllMissions();
  
  let message = `📝 <b>Задания локаций</b>\n\n`;
  Object.entries(LOCATIONS).forEach(([locId, locData]) => {
    const mission = missions.find(m => m.location === locId);
    const status = mission ? '✅' : '❌';
    message += `${status} ${locData.emoji} ${locData.name}\n`;
  });
  
  message += `\nВыбери локацию для редактирования:`;
  
  const buttons = Object.entries(LOCATIONS).map(([locId, locData]) => 
    Markup.button.callback(`${locData.emoji} ${locData.name}`, `edit_mission_${locId}`)
  );
  
  const keyboard = Markup.inlineKeyboard([
    [buttons[0], buttons[1]],
    [buttons[2], buttons[3]],
    [buttons[4], buttons[5]],
    [Markup.button.callback('🔙 Назад', 'admin_dashboard')]
  ]);
  
  await ctx.answerCbQuery();
  await ctx.editMessageText(message, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

// Редактирование задания (заглушка для демонстрации)
bot.action(/^edit_mission_(.+)$/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  ctx.session.editingMission = locationId;
  ctx.session.step = 'text';
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `✏️ <b>Редактирование задания</b>\n` +
    `Локация: <b>${LOCATIONS[locationId].name}</b>\n\n` +
    `1️⃣ Введи текст задания:`
  );
});

// Раздел "Пароли"
bot.action('admin_passwords', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const passwords = await dbService.getAllPasswords();
  
  let message = `🔑 <b>Пароли доступа к локациям</b>\n\n`;
  Object.entries(LOCATIONS).forEach(([locId, locData]) => {
    const pwd = passwords.find(p => p.location === locId);
    const status = pwd ? '✅' : '❌';
    message += `${status} ${locData.emoji} ${locData.name}: ${pwd?.password || '<i>не задан</i>'}\n`;
  });
  
  message += `\nВыбери локацию для изменения пароля:`;
  
  const buttons = Object.entries(LOCATIONS).map(([locId, locData]) => 
    Markup.button.callback(`${locData.emoji} ${locData.name}`, `edit_password_${locId}`)
  );
  
  const keyboard = Markup.inlineKeyboard([
    [buttons[0], buttons[1]],
    [buttons[2], buttons[3]],
    [buttons[4], buttons[5]],
    [Markup.button.callback('🔙 Назад', 'admin_dashboard')]
  ]);
  
  await ctx.answerCbQuery();
  await ctx.editMessageText(message, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

// Редактирование пароля
bot.action(/^edit_password_(.+)$/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  ctx.session.editingPassword = locationId;
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🔑 <b>Изменение пароля</b>\n` +
    `Локация: <b>${LOCATIONS[locationId].name}</b>\n\n` +
    `Введи <b>новый пароль</b> для доступа к локации:`
  );
});

// Раздел "Подсказки"
bot.action('admin_hints', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const allHints = await Promise.all(
    Object.keys(LOCATIONS).map(async loc => ({
      location: loc,
      count: (await dbService.getHintsForLocation(loc)).length
    }))
  );
  
  let message = `💡 <b>Управление подсказками</b>\n\n`;
  allHints.forEach(h => {
    message += `${LOCATIONS[h.location].emoji} ${LOCATIONS[h.location].name}: ${h.count} подсказок\n`;
  });
  
  message += `\nВыбери действие:`;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Добавить подсказку', 'add_hint')],
    [Markup.button.callback('🔙 Назад', 'admin_dashboard')]
  ]);
  
  await ctx.answerCbQuery();
  await ctx.editMessageText(message, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

// Добавление подсказки - выбор локации
bot.action('add_hint', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const buttons = Object.entries(LOCATIONS).map(([locId, locData]) => 
    Markup.button.callback(`${locData.emoji} ${locData.name}`, `hint_loc_${locId}`)
  );
  
  const keyboard = Markup.inlineKeyboard([
    [buttons[0], buttons[1]],
    [buttons[2], buttons[3]],
    [buttons[4], buttons[5]],
    [Markup.button.callback('🔙 Отмена', 'admin_hints')]
  ]);
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `➕ <b>Добавление подсказки</b>\n\nВыбери локацию:`,
    { reply_markup: keyboard }
  );
});

// Выбор локации для подсказки
bot.action(/^hint_loc_(.+)$/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  ctx.session.hintLocation = locationId;
  ctx.session.step = 'level';
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🔢 <b>Уровень подсказки</b>\n\n` +
    `Введи уровень детализации (1-3):\n` +
    `1️⃣ - Общая подсказка\n` +
    `2️⃣ - Конкретная подсказка\n` +
    `3️⃣ - Детальная подсказка`
  );
});

// Раздел "Статистика"
bot.action('admin_stats', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const stats = await dbService.getAdminStats();
  
  let message = `📊 <b>Статистика квеста</b>\n\n`;
  message += `👥 Всего игроков: ${stats.totalPlayers}\n`;
  message += `🏆 Завершили квест: ${stats.completedPlayers}\n\n`;
  
  message += `<b>Последние события:</b>\n`;
  stats.recentEvents.slice(0, 5).forEach(event => {
    const time = new Date(event.created_at).toLocaleTimeString('ru-RU');
    message += `\n▫️ ${time} | ${event.type}`;
    if (event.location) message += ` | ${LOCATIONS[event.location]?.name || event.location}`;
  });
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Обновить', 'admin_stats')],
    [Markup.button.callback('🔙 Назад', 'admin_dashboard')]
  ]);
  
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } catch (e) {
    if (!e.description?.includes('message is not modified')) {
      console.error('Stats update error:', e);
    }
  }
});

// ============ ОБРАБОТКА ТЕКСТА (пароли, подсказки) ============

bot.on('text', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  // Настройка пароля
  if (ctx.session?.editingPassword) {
    const locationId = ctx.session.editingPassword;
    const password = ctx.message.text.trim();
    
    if (password.length < 4) {
      await ctx.reply('⚠️ Пароль должен быть не менее 4 символов. Попробуй ещё раз:');
      return;
    }
    
    try {
      await dbService.setPassword(locationId, password);
      
      await ctx.replyWithHTML(
        `✅ <b>Пароль установлен!</b>\n\n` +
        `Локация: ${LOCATIONS[locationId].name}\n` +
        `Пароль: <code>${password}</code>\n\n` +
        `<i>⚠️ Размести этот пароль на территории локации</i>`
      );
      
      delete ctx.session.editingPassword;
      await showAdminDashboard(ctx);
    } catch (error) {
      console.error('Password save error:', error);
      await ctx.replyWithHTML(`❌ Ошибка сохранения: ${error.message}`);
    }
  }
  
  // Добавление подсказки - уровень
  else if (ctx.session?.hintLocation && ctx.session.step === 'level') {
    const level = parseInt(ctx.message.text);
    if (isNaN(level) || level < 1 || level > 3) {
      await ctx.reply('❌ Неверный уровень. Введи число от 1 до 3:');
      return;
    }
    ctx.session.hintLevel = level;
    ctx.session.step = 'text';
    await ctx.replyWithHTML(`📝 Введи <b>текст подсказки</b> уровня ${level}:`);
  }
  
  // Добавление подсказки - текст
  else if (ctx.session?.hintLocation && ctx.session.step === 'text') {
    try {
      const hint = await dbService.createHint({
        location: ctx.session.hintLocation,
        hintLevel: ctx.session.hintLevel,
        text: ctx.message.text
      });
      
      await ctx.replyWithHTML(
        `✅ <b>Подсказка создана!</b>\n\n` +
        `Локация: ${LOCATIONS[ctx.session.hintLocation].name}\n` +
        `Уровень: ${ctx.session.hintLevel}\n` +
        `Текст: ${hint.text}`
      );
      
      delete ctx.session.hintLocation;
      delete ctx.session.hintLevel;
      delete ctx.session.step;
      await showAdminDashboard(ctx);
    } catch (error) {
      console.error('Hint save error:', error);
      await ctx.replyWithHTML(`❌ Ошибка создания подсказки: ${error.message}`);
    }
  }
  
  // Настройка задания - текст
  else if (ctx.session?.editingMission && ctx.session.step === 'text') {
    ctx.session.missionText = ctx.message.text;
    ctx.session.step = 'answer';
    await ctx.replyWithHTML(`2️⃣ Введи <b>правильный ответ</b> на задание:`);
  }
  
  // Настройка задания - ответ
  else if (ctx.session?.editingMission && ctx.session.step === 'answer') {
    ctx.session.missionAnswer = ctx.message.text;
    ctx.session.step = 'image';
    await ctx.replyWithHTML(
      `3️⃣ Введи <b>URL изображения</b> для задания (или "-" для пропуска):\n` +
      `<i>Рекомендуется: изображение 800x600px, JPG/PNG</i>`
    );
  }
  
  // Настройка задания - изображение
  else if (ctx.session?.editingMission && ctx.session.step === 'image') {
    const imageUrl = ctx.message.text !== '-' ? ctx.message.text : null;
    
    try {
      await dbService.setMission(ctx.session.editingMission, {
        text: ctx.session.missionText,
        answer: ctx.session.missionAnswer,
        imageUrl: imageUrl
      });
      
      await ctx.replyWithHTML(
        `✅ <b>Задание сохранено!</b>\n\n` +
        `Локация: ${LOCATIONS[ctx.session.editingMission].name}\n` +
        `Текст: ${ctx.session.missionText.substring(0, 50)}...\n` +
        `Ответ: ${ctx.session.missionAnswer}`
      );
      
      delete ctx.session.editingMission;
      delete ctx.session.step;
      delete ctx.session.missionText;
      delete ctx.session.missionAnswer;
      await showAdminDashboard(ctx);
    } catch (error) {
      console.error('Mission save error:', error);
      await ctx.replyWithHTML(`❌ Ошибка сохранения задания: ${error.message}`);
    }
  }
});

// Запуск бота
bot.launch();
console.log('✅ Telegram Bot запущен');
console.log('🔧 Admin IDs:', ADMIN_USER_IDS);
console.log('🌐 Frontend URL:', FRONTEND_URL);
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
