// bot.js — минимальная рабочая версия с исправленными кнопками
import { Telegraf } from 'telegraf';
import sqlite3 from 'better-sqlite3';
import 'dotenv/config';

// ==================== КОНФИГУРАЦИЯ ====================
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://qweasader.github.io/cybervillage_defend/';

if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не установлен');
if (ADMIN_USER_IDS[0] === 123456789) throw new Error('Замените 123456789 на ваш реальный Telegram ID');

// ==================== БАЗА ДАННЫХ ====================
const sqlite = sqlite3('database.sqlite');
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS location_passwords (
    location TEXT PRIMARY KEY,
    password TEXT NOT NULL
  )
`);
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL,
    hints_used INTEGER DEFAULT 0,
    completed_locations TEXT DEFAULT '[]'
  )
`);

// ==================== БОТ ====================
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

const LOCATIONS = {
  gates: { name: 'Врата Кибердеревни', emoji: '🚪' },
  dome: { name: 'Купол Защиты', emoji: '🛡️' },
  mirror: { name: 'Зеркало Истины', emoji: '🪞' },
  stone: { name: 'Камень Пророчеств', emoji: '🔮' },
  hut: { name: 'Хижина Хранителя', emoji: '🏠' },
  lair: { name: 'Логово Вируса', emoji: '👾' }
};

// Middleware для проверки админа
bot.use((ctx, next) => {
  ctx.isAdmin = ADMIN_USER_IDS.includes(ctx.from?.id);
  return next();
});

// Команда /start
bot.start((ctx) => {
  ctx.replyWithHTML(
    `👋 <b>Защита Кибердеревни</b>\n\n` +
    `Начни квест:`,
    {
      reply_markup: {
        inline_keyboard: [[{
          text: '🚀 Начать',
          web_app: { url: FRONTEND_URL }
        }]]
      }
    }
  );
});

// Команда /admin — РАБОЧАЯ АДМИН-ПАНЕЛЬ
bot.command('admin', async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.replyWithHTML(`🚫 Доступ запрещён. Твой ID: <code>${ctx.from.id}</code>`);
    return;
  }
  
  // Получаем пароли
  const passwords = sqlite.prepare('SELECT * FROM location_passwords').all();
  
  // Формируем сообщение
  let msg = `🔧 <b>Админ-панель</b>\n\n`;
  Object.entries(LOCATIONS).forEach(([id, loc]) => {
    const pwd = passwords.find(p => p.location === id);
    msg += `${pwd ? '✅' : '❌'} ${loc.emoji} ${loc.name}: ${pwd?.password || '<i>не задан</i>'}\n`;
  });
  
  // ИСПРАВЛЕНО: правильный синтаксис кнопок callback_data:
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🚪 Врата', callback_data: 'set_pwd_gates' },
        { text: '🛡️ Купол', callback_data: 'set_pwd_dome' }
      ],
      [
        { text: '🪞 Зеркало', callback_data: 'set_pwd_mirror' },
        { text: '🔮 Камень', callback_data: 'set_pwd_stone' }
      ],
      [
        { text: '🏠 Хижина', callback_data: 'set_pwd_hut' },
        { text: '👾 Логово', callback_data: 'set_pwd_lair' }
      ]
    ]
  };
  
  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

// Обработчики кнопок — ИСПРАВЛЕНО: правильный синтаксис
bot.action('set_pwd_gates', (ctx) => handleSetPassword(ctx, 'gates'));
bot.action('set_pwd_dome', (ctx) => handleSetPassword(ctx, 'dome'));
bot.action('set_pwd_mirror', (ctx) => handleSetPassword(ctx, 'mirror'));
bot.action('set_pwd_stone', (ctx) => handleSetPassword(ctx, 'stone'));
bot.action('set_pwd_hut', (ctx) => handleSetPassword(ctx, 'hut'));
bot.action('set_pwd_lair', (ctx) => handleSetPassword(ctx, 'lair'));

// Универсальный обработчик установки пароля
async function handleSetPassword(ctx, locationId) {
  if (!ctx.isAdmin) return;
  
  // Сохраняем локацию в сессии (простой объект)
  ctx.session = ctx.session || {};
  ctx.session.settingPasswordFor = locationId;
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🔑 Введите пароль для "${LOCATIONS[locationId].name}":\n` +
    `<i>Регистр важен! Пример: gate2024</i>`
  );
}

// Обработка текста для пароля
bot.on('text', (ctx) => {
  if (!ctx.isAdmin || !ctx.session?.settingPasswordFor) return;
  
  const locationId = ctx.session.settingPasswordFor;
  const password = ctx.message.text.trim();
  
  if (password.length < 4) {
    ctx.reply('⚠️ Пароль должен быть не менее 4 символов');
    return;
  }
  
  // Сохраняем пароль БЕЗ ПРОБЕЛОВ
  sqlite.prepare(`
    INSERT OR REPLACE INTO location_passwords (location, password)
    VALUES (?, ?)
  `).run(locationId, password);
  
  ctx.replyWithHTML(
    `✅ Пароль для "${LOCATIONS[locationId].name}" установлен:\n` +
    `<code>${password}</code>`
  );
  
  // Очищаем сессию
  delete ctx.session.settingPasswordFor;
});

// Запуск бота
bot.launch();
console.log('✅ Бот запущен');
console.log('🔧 Админ ID:', ADMIN_USER_IDS[0]);
console.log('🌐 Фронтенд:', FRONTEND_URL);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
