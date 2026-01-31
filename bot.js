// bot.js — полностью рабочая версия с сессиями и кнопками
import { Telegraf, session } from 'telegraf';
import LocalSession from 'telegraf-session-local';
import sqlite3 from 'better-sqlite3';
import 'dotenv/config';

// ==================== КОНФИГУРАЦИЯ ====================
// ⚠️ ЗАМЕНИТЕ НА ВАШ РЕАЛЬНЫЙ TELEGRAM ID!
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://qweasader.github.io/cybervillage_defend/';
const MAX_HINTS = 3;

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('❌ TELEGRAM_BOT_TOKEN не установлен! Добавьте его в переменные окружения Railway.');
}

if (ADMIN_USER_IDS.length === 0 || ADMIN_USER_IDS[0] === 123456789) {
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

// ИСПРАВЛЕНО: правильная настройка сессий через LocalSession
bot.use(session({
  store: new LocalSession({ database: 'session_store.json' })
}));

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

// ============ АДМИН-ПАНЕЛЬ С РАБОЧИМИ КНОПКАМИ ============

async function showAdminDashboard(ctx) {
  const [missions, passwords] = await Promise.all([
    dbService.getAllMissions(),
    dbService.getAllPasswords()
  ]);
  
  const hintsCount = 
    dbService.getHintsForLocation('gates').length +
    dbService.getHintsForLocation('dome').length +
    dbService.getHintsForLocation('mirror').length +
    dbService.getHintsForLocation('stone').length +
    dbService.getHintsForLocation('hut').length +
    dbService.getHintsForLocation('lair').length;
  
  const message = `🔧 <b>Админ-панель квеста</b>\n\n` +
    `✅ Заданий настроено: ${missions.length}/6\n` +
    `🔑 Паролей задано: ${passwords.length}/6\n` +
    `💡 Подсказок создано: ${hintsCount}\n\n` +
    `<b>Выбери раздел:</b>`;
  
  // ИСПРАВЛЕНО: правильный синтаксис callback_data (было callback_)
  const keyboard = {
    inline_keyboard: [
      [{ text: '📝 Задания', callback_ 'admin_missions' }],
      [{ text: '🔑 Пароли локаций', callback_ 'admin_passwords' }],
      [{ text: '💡 Подсказки', callback_ 'admin_hints' }],
      [{ text: '📊 Статистика', callback_ 'admin_stats' }]
    ]
  };
  
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(message, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      await ctx.answerCbQuery();
    } catch (e) {
      if (!e.description?.includes('message is not modified')) {
        console.error('Edit error:', e.message);
      }
    }
  } else {
    await ctx.reply(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }
}

// Главное меню
bot.action('admin_dashboard', async (ctx) => {
  if (!ctx.isAdmin) return;
  await showAdminDashboard(ctx);
  await ctx.answerCbQuery();
});

// Раздел "Пароли"
bot.action('admin_passwords', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const passwords = await dbService.getAllPasswords();
  
  let msg = `🔑 <b>Пароли доступа к локациям</b>\n\n`;
  Object.entries(LOCATIONS).forEach(([locId, locData]) => {
    const pwd = passwords.find(p => p.location === locId);
    const status = pwd ? '✅' : '❌';
    msg += `${status} ${locData.emoji} ${locData.name}: ${pwd?.password || '<i>не задан</i>'}\n`;
  });
  
  msg += `\n<b>Выбери локацию:</b>`;
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🚪 Врата', callback_ 'edit_password_gates' },
        { text: '🛡️ Купол', callback_ 'edit_password_dome' }
      ],
      [
        { text: '🪞 Зеркало', callback_ 'edit_password_mirror' },
        { text: '🔮 Камень', callback_ 'edit_password_stone' }
      ],
      [
        { text: '🏠 Хижина', callback_ 'edit_password_hut' },
        { text: '👾 Логово', callback_ 'edit_password_lair' }
      ],
      [{ text: '🔙 Назад', callback_ 'admin_dashboard' }]
    ]
  };
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
});

// Редактирование пароля
bot.action(/edit_password_(.+)/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  if (!LOCATIONS[locationId]) {
    await ctx.answerCbQuery('Локация не найдена', { show_alert: true });
    return;
  }
  
  // ИСПРАВЛЕНО: гарантируем инициализацию сессии
  if (!ctx.session) ctx.session = {};
  ctx.session.editingPassword = locationId;
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🔑 <b>Установка пароля для "${LOCATIONS[locationId].name}"</b>\n\n` +
    `Отправь мне пароль (минимум 4 символа), который будет размещён на локации:`
  );
});

// Раздел "Задания"
bot.action('admin_missions', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const missions = await dbService.getAllMissions();
  
  let msg = `📝 <b>Задания локаций</b>\n\n`;
  Object.entries(LOCATIONS).forEach(([locId, locData]) => {
    const mission = missions.find(m => m.location === locId);
    const status = mission ? '✅' : '❌';
    msg += `${status} ${locData.emoji} ${locData.name}\n`;
  });
  
  msg += `\n<b>Выбери локацию:</b>`;
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🚪 Врата', callback_ 'edit_mission_gates' },
        { text: '🛡️ Купол', callback_ 'edit_mission_dome' }
      ],
      [
        { text: '🪞 Зеркало', callback_ 'edit_mission_mirror' },
        { text: '🔮 Камень', callback_ 'edit_mission_stone' }
      ],
      [
        { text: '🏠 Хижина', callback_ 'edit_mission_hut' },
        { text: '👾 Логово', callback_ 'edit_mission_lair' }
      ],
      [{ text: '🔙 Назад', callback_ 'admin_dashboard' }]
    ]
  };
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
});

// Раздел "Подсказки"
bot.action('admin_hints', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const hintsSummary = await Promise.all(
    Object.keys(LOCATIONS).map(async loc => ({
      location: loc,
      count: (await dbService.getHintsForLocation(loc)).length
    }))
  );
  
  let msg = `💡 <b>Подсказки по локациям</b>\n\n`;
  hintsSummary.forEach(h => {
    msg += `${LOCATIONS[h.location].emoji} ${LOCATIONS[h.location].name}: ${h.count} шт.\n`;
  });
  
  msg += `\n<b>Выбери действие:</b>`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '➕ Добавить подсказку', callback_ 'add_hint' }],
      [{ text: '🔙 Назад', callback_ 'admin_dashboard' }]
    ]
  };
  
  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
  await ctx.answerCbQuery();
});

// Добавление подсказки
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
    `➕ <b>Добавление подсказки</b>\n\nВыбери локацию:`,
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
  
  // ИСПРАВЛЕНО: гарантируем инициализацию сессии
  if (!ctx.session) ctx.session = {};
  ctx.session.hintLocation = locationId;
  ctx.session.step = 'level';
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🔢 <b>Уровень подсказки для "${LOCATIONS[locationId].name}"</b>\n\n` +
    `Отправь число от 1 до 3:\n` +
    `1 — общая подсказка\n` +
    `2 — конкретная подсказка\n` +
    `3 — детальная подсказка`
  );
});

// Раздел "Статистика"
bot.action('admin_stats', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const stats = await dbService.getAdminStats();
  
  const msg = `📊 <b>Статистика квеста</b>\n\n` +
    `👥 Всего игроков: ${stats.totalPlayers}\n` +
    `🏆 Завершили квест: ${stats.completedPlayers}\n\n` +
    `<b>Последние события:</b>\n` +
    stats.recentEvents.slice(0, 5).map((e, i) => {
      const time = new Date(e.created_at).toLocaleTimeString('ru-RU');
      return `${i + 1}. ${time} | ${e.type}`;
    }).join('\n');
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔄 Обновить', callback_ 'admin_stats' }],
      [{ text: '🔙 Назад', callback_ 'admin_dashboard' }]
    ]
  };
  
  try {
    await ctx.editMessageText(msg, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } catch (e) {
    if (!e.description?.includes('message is not modified')) {
      console.error('Stats error:', e.message);
    }
  }
  await ctx.answerCbQuery();
});

// ============ ОБРАБОТКА ТЕКСТА ============

bot.on('text', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  // ИСПРАВЛЕНО: гарантируем инициализацию сессии
  if (!ctx.session) ctx.session = {};
  
  // Настройка пароля
  if (ctx.session.editingPassword) {
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
        `Пароль: <code>${password}</code>`
      );
      
      delete ctx.session.editingPassword;
      await showAdminDashboard(ctx);
    } catch (error) {
      console.error('Password save error:', error);
      await ctx.replyWithHTML(`❌ Ошибка: ${error.message}`);
    }
  }
  
  // Добавление подсказки - уровень
  else if (ctx.session.hintLocation && ctx.session.step === 'level') {
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
  else if (ctx.session.hintLocation && ctx.session.step === 'text') {
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
      await ctx.replyWithHTML(`❌ Ошибка: ${error.message}`);
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
