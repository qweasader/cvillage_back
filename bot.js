// bot.js — Telegram бот с админ-панелью
import { Telegraf } from 'telegraf';
import { Database } from './database.js';

// ==================== КОНФИГУРАЦИЯ ====================
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://qweasader.github.io/cybervillage_defend/';

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('❌ TELEGRAM_BOT_TOKEN не установлен!');
}

if (ADMIN_USER_IDS.length === 0 || ADMIN_USER_IDS[0] === 123456789) {
  throw new Error('❌ ADMIN_USER_IDS не настроен! Замените 123456789 на ваш реальный Telegram ID');
}

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
const db = new Database();
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

const LOCATIONS = {
  gates: { name: 'Врата Кибердеревни', emoji: '🚪', order: 1 },
  dome: { name: 'Купол Защиты', emoji: '🛡️', order: 2 },
  mirror: { name: 'Зеркало Истины', emoji: '🪞', order: 3 },
  stone: { name: 'Камень Пророчеств', emoji: '🔮', order: 4 },
  hut: { name: 'Хижина Хранителя', emoji: '🏠', order: 5 },
  lair: { name: 'Логово Вируса', emoji: '👾', order: 6 }
};

// Middleware для админа
bot.use((ctx, next) => {
  ctx.isAdmin = ADMIN_USER_IDS.includes(ctx.from?.id);
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

// Команда /admin
bot.command('admin', async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.replyWithHTML(
      `🚫 <b>Доступ запрещён</b>\n\n` +
      `Твой ID: <code>${ctx.from.id}</code>`
    );
    return;
  }
  
  await showAdminDashboard(ctx);
});

// Админ-панель
async function showAdminDashboard(ctx) {
  const [missions, passwords] = await Promise.all([
    db.getAllMissions(),
    db.getAllPasswords()
  ]);
  
  const hintsCount = 
    db.getHintsForLocation('gates').length +
    db.getHintsForLocation('dome').length +
    db.getHintsForLocation('mirror').length +
    db.getHintsForLocation('stone').length +
    db.getHintsForLocation('hut').length +
    db.getHintsForLocation('lair').length;
  
  const message = `🔧 <b>Админ-панель квеста</b>\n\n` +
    `✅ Заданий: ${missions.length}/6\n` +
    `🔑 Паролей: ${passwords.length}/6\n` +
    `💡 Подсказок: ${hintsCount}\n\n` +
    `<b>Выбери раздел:</b>`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔑 Пароли локаций', callback_ 'admin_passwords' }],
      [{ text: '📝 Задания', callback_ 'admin_missions' }],
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

// Раздел "Пароли" — ИСПРАВЛЕНО: все кнопки с правильным синтаксисом
bot.action('admin_passwords', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const passwords = await db.getAllPasswords();
  
  let msg = `🔑 <b>Пароли доступа к локациям</b>\n\n`;
  Object.entries(LOCATIONS).forEach(([locId, locData]) => {
    const pwd = passwords.find(p => p.location === locId);
    const status = pwd ? '✅' : '❌';
    msg += `${status} ${locData.emoji} ${locData.name}: <code>${pwd?.password || 'не задан'}</code>\n`;
  });
  
  msg += `\n<b>Выбери локацию для настройки пароля:</b>`;
  
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

// Редактирование пароля — КРИТИЧЕСКИ ВАЖНО: очистка пробелов
bot.action(/edit_password_(.+)/, async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const locationId = ctx.match[1];
  if (!LOCATIONS[locationId]) {
    await ctx.answerCbQuery('Локация не найдена', { show_alert: true });
    return;
  }
  
  ctx.session = { editingPassword: locationId };
  
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `🔑 <b>Установка пароля для "${LOCATIONS[locationId].name}"</b>\n\n` +
    `Отправь пароль (регистр важен!).\n` +
    `<b>Рекомендации:</b>\n` +
    `• Используй латинские буквы и цифры\n` +
    `• Избегай пробелов в начале/конце\n` +
    `• Пример: <code>gate2024</code>`
  );
});

// Обработка текста для пароля — КРИТИЧЕСКИ ВАЖНО: очистка пробелов
bot.on('text', async (ctx) => {
  if (!ctx.isAdmin || !ctx.session?.editingPassword) return;
  
  const locationId = ctx.session.editingPassword;
  const password = ctx.message.text.trim(); // ОЧИСТКА ПРОБЕЛОВ!
  
  if (password.length < 4) {
    await ctx.reply('⚠️ Пароль должен быть не менее 4 символов. Попробуй ещё раз:');
    return;
  }
  
  try {
    // Сохраняем пароль (внутри setPassword тоже есть trim())
    db.setPassword(locationId, password);
    
    await ctx.replyWithHTML(
      `✅ <b>Пароль установлен!</b>\n\n` +
      `Локация: ${LOCATIONS[locationId].name}\n` +
      `Пароль: <code>${password}</code>\n\n` +
      `ℹ️ Игроки должны ввести этот пароль <b>точно</b> (регистр и символы важны!)`
    );
    
    delete ctx.session.editingPassword;
    await showAdminDashboard(ctx);
  } catch (error) {
    console.error('Password save error:', error);
    await ctx.replyWithHTML(`❌ Ошибка: ${error.message}`);
  }
});

// Прочие команды (/stats, /hint) и обработчики — как в предыдущих версиях
bot.command('stats', async (ctx) => {
  const player = await db.getPlayer(ctx.from.id);
  if (!player) {
    await ctx.reply('Сначала начни игру командой /start');
    return;
  }
  const completed = JSON.parse(player.completed_locations || '[]').length;
  const hintsLeft = 3 - player.hints_used;
  await ctx.replyWithHTML(
    `📊 <b>Твоя статистика</b>\n\n` +
    `👤 Игрок: ${player.first_name || 'Неизвестно'}\n` +
    `✅ Пройдено локаций: ${completed}/6\n` +
    `💡 Осталось подсказок: ${hintsLeft}/3`
  );
});

bot.command('hint', async (ctx) => {
  const player = await db.getPlayer(ctx.from.id);
  if (!player) {
    await ctx.reply('Сначала начни игру командой /start');
    return;
  }
  if (player.hints_used >= 3) {
    await ctx.reply('🚫 У тебя закончились подсказки!');
    return;
  }
  
  const allLocations = Object.entries(LOCATIONS)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([id]) => id);
  
  const completed = JSON.parse(player.completed_locations || '[]');
  const currentLocation = allLocations.find(loc => !completed.includes(loc)) || allLocations[0];
  
  const hintLevel = player.hints_used + 1;
  const hint = await db.getHint(currentLocation, hintLevel);
  
  if (!hint) {
    await ctx.reply('🤔 Подсказка не настроена. Обратись к организаторам.');
    return;
  }
  
  await db.useHint(ctx.from.id);
  const hintsLeft = 3 - (player.hints_used + 1);
  
  await ctx.replyWithHTML(
    `💡 <b>Подсказка для "${LOCATIONS[currentLocation].name}"</b>\n\n` +
    `${hint.text}\n\n` +
    `Осталось подсказок: ${hintsLeft}/3`
  );
});

// Запуск бота
bot.launch();
console.log('✅ Telegram Bot запущен');
console.log('🔧 Admin IDs:', ADMIN_USER_IDS);
console.log('⚠️  ВАЖНО: Для работы фронтенда также запустите server.js!');
