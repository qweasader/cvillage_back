// bot.js — полный бот в одном файле без конфликтов
// Запуск: node bot.js

import { Telegraf, session, Markup } from 'telegraf';
import sqlite3 from 'better-sqlite3';
import 'dotenv/config';

// ==================== КОНФИГУРАЦИЯ ====================
// ⚠️ ЗАМЕНИТЕ ЭТИ ЗНАЧЕНИЯ НА СВОИ!
const ADMIN_USER_IDS = [
  123456789,   // ← ВАШ Telegram ID (получите через @userinfobot)
  987654321    // ← дополнительные админы (опционально)
];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://qweasader.github.io/cybervillage_defend/';
const MAX_HINTS = 3;

// Проверка обязательных настроек
if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('❌ TELEGRAM_BOT_TOKEN не установлен!\nДобавьте его в переменные окружения Railway.');
}

if (ADMIN_USER_IDS.length === 0 || ADMIN_USER_IDS[0] === 123456789) {
  throw new Error('❌ ADMIN_USER_IDS не настроен!\nЗамените 123456789 на ваш реальный Telegram ID в начале файла bot.js');
}

// ==================== БАЗА ДАННЫХ ====================
const sqlite = sqlite3('database.sqlite', { verbose: false });

// Инициализация таблиц
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

// Методы БД (без конфликта имён)
const dbService = {
  getPlayer: (userId) => sqlite.prepare('SELECT * FROM players WHERE id = ?').get(userId),
  
  createOrUpdatePlayer(userId, data) {
    const existing = this.getPlayer(userId);
    
    if (existing) {
      sqlite.prepare(`
        UPDATE players 
        SET username = ?, first_name = ?, last_name = ?, team_id = ?, last_activity = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        data.username || null,
        data.first_name || '',
        data.last_name || null,
        data.team_id || null,
        userId
      );
    } else {
      sqlite.prepare(`
        INSERT INTO players (id, username, first_name, last_name, team_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        userId,
        data.username || null,
        data.first_name || '',
        data.last_name || null,
        data.team_id || null
      );
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
      sqlite.prepare('UPDATE players SET completed_locations = ? WHERE id = ?')
        .run(JSON.stringify(completed), userId);
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
      sqlite.prepare('UPDATE location_passwords SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE location = ?')
        .run(password, location);
    } else {
      sqlite.prepare('INSERT INTO location_passwords (location, password) VALUES (?, ?)')
        .run(location, password);
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
    sqlite.prepare('DELETE FROM hints WHERE location = ? AND hint_level = ?')
      .run(hintData.location, hintData.hintLevel);
    
    sqlite.prepare(`
      INSERT INTO hints (location, hint_level, text)
      VALUES (?, ?, ?)
    `).run(hintData.location, hintData.hintLevel, hintData.text);
    
    return this.getHint(hintData.location, hintData.hintLevel);
  },
  
  getHintsForLocation: (location) => 
    sqlite.prepare('SELECT * FROM hints WHERE location = ? ORDER BY hint_level').all(location),
  
  logEvent(eventType, userId = null, location = null, eventData = {}) {
    sqlite.prepare(`
      INSERT INTO events (type, user_id, location, data)
      VALUES (?, ?, ?, ?)
    `).run(eventType, userId, location, JSON.stringify(eventData));
  },
  
  getAdminStats() {
    const totalPlayers = sqlite.prepare('SELECT COUNT(*) as count FROM players').get().count;
    const completedPlayers = sqlite.prepare(`
      SELECT COUNT(*) as count 
      FROM players 
      WHERE json_array_length(completed_locations) >= 6
    `).get().count;
    
    const recentEvents = sqlite.prepare(`
      SELECT * FROM events 
      ORDER BY created_at DESC 
      LIMIT 10
    `).all();
    
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

// Локации квеста
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
        inline_keyboard: [[
          {
            text: '🚀 Начать квест',
            web_app: { url: FRONTEND_URL }
          }
        ]]
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
  
  const allLocations = Object.entries(LOCATIONS)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([id]) => id);
  
  const completed = JSON.parse(player.completed_locations || '[]');
  const currentLocation = allLocations.find(loc => !completed.includes(loc)) || allLocations[0];
  
  const hintLevel = player.hints_used + 1;
  const hint = await dbService.getHint(currentLocation, hintLevel);
  
  if (!hint) {
    await ctx.reply('🤔 Подсказка не настроена. Обратись к организаторам.');
    return;
  }
  
  await dbService.useHint(ctx.from.id);
  await dbService.logEvent('hint_used', ctx.from.id, currentLocation, {
    hint_level: hintLevel,
    hint_id: hint.id
  });
  
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
  const [missions, passwords] = await Promise.all([
    dbService.getAllMissions(),
    dbService.getAllPasswords()
  ]);
  
  const hintsCount = dbService.getHintsForLocation('gates').length + 
                     dbService.getHintsForLocation('dome').length +
                     dbService.getHintsForLocation('mirror').length +
                     dbService.getHintsForLocation('stone').length +
                     dbService.getHintsForLocation('hut').length +
                     dbService.getHintsForLocation('lair').length;
  
  let message = `🔧 <b>Админ-панель квеста</b>\n\n`;
  message += `✅ Заданий настроено: ${missions.length}/6\n`;
  message += `🔑 Паролей задано: ${passwords.length}/6\n`;
  message += `💡 Подсказок создано: ${hintsCount}\n`;
  message += `<b>Выбери раздел:</b>`;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Задания', 'admin_missions')],
    [Markup.button.callback('🔑 Пароли', 'admin_passwords')],
    [Markup.button.callback('💡 Подсказки', 'admin_hints')],
    [Markup.button.callback('📊 Статистика', 'admin_stats')]
  ]);
  
  if (ctx.callbackQuery) {
    await ctx.editMessageText(message, {
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

// Настройка паролей
bot.action('admin_passwords', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const passwords = await dbService.getAllPasswords();
  
  let message = `🔑 <b>Пароли доступа к локациям</b>\n\n`;
  Object.entries(LOCATIONS).forEach(([locId, locData]) => {
    const pwd = passwords.find(p => p.location === locId);
    const status = pwd ? '✅' : '❌';
    message += `${status} ${locData.emoji} ${locData.name}: ${pwd?.password || '<i>не задан</i>'}\n`;
  });
  
  message += `\nВыбери локацию:`;
  
  const buttons = Object.entries(LOCATIONS).map(([locId, locData]) => 
    Markup.button.callback(`${locData.emoji} ${locData.name}`, `edit_password_${locId}`)
  );
  
  const keyboard = Markup.inlineKeyboard([
    [buttons[0], buttons[1]],
    [buttons[2], buttons[3]],
    [buttons[4], buttons[5]],
    [Markup.button.callback('🔙 Назад', 'admin_dashboard')]
  ]);
  
  await ctx.editMessageText(message, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

bot.action(/^edit_password_(.+)$/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  ctx.session.editingPassword = locationId;
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🔑 <b>Изменение пароля</b>\n` +
    `Локация: <b>${LOCATIONS[locationId].name}</b>\n\n` +
    `Введи <b>новый пароль</b>:`
  );
});

bot.action('admin_dashboard', showAdminDashboard);

// Обработка текста для пароля
bot.on('text', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  if (ctx.session?.editingPassword) {
    const locationId = ctx.session.editingPassword;
    const password = ctx.message.text.trim();
    
    if (password.length < 4) {
      await ctx.reply('⚠️ Пароль должен быть не менее 4 символов.');
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
});

// Запуск бота
bot.launch();
console.log('✅ Telegram Bot запущен');
console.log('🔧 Admin IDs:', ADMIN_USER_IDS);
console.log('🌐 Frontend URL:', FRONTEND_URL);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
