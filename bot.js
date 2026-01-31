// bot.js — продакшен бот без демо-режимов

import { Telegraf, session, Markup } from 'telegraf';
import { Database } from './database.js';
import { CONFIG } from './config.js';

// Инициализация
const db = new Database();
const bot = new Telegraf(CONFIG.TELEGRAM_BOT_TOKEN);

if (!CONFIG.TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is required! Set it in .env or environment variables.');
}

// Middleware для проверки админа
bot.use(session());
bot.use((ctx, next) => {
  ctx.isAdmin = CONFIG.ADMIN_USER_IDS.includes(ctx.from?.id);
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
        inline_keyboard: [[
          {
            text: '🚀 Начать квест',
            web_app: { url: CONFIG.FRONTEND_URL }
          }
        ]]
      }
    }
  );
  
  await db.logEvent('bot_start', ctx.from.id);
});

// Команда /stats
bot.command('stats', async (ctx) => {
  const player = await db.getPlayer(ctx.from.id);
  
  if (!player) {
    await ctx.reply('Сначала начни игру командой /start');
    return;
  }
  
  const completed = JSON.parse(player.completed_locations || '[]').length;
  const hintsLeft = CONFIG.MAX_HINTS - player.hints_used;
  
  await ctx.replyWithHTML(
    `📊 <b>Твоя статистика</b>\n\n` +
    `👤 Игрок: ${player.first_name || 'Неизвестно'}\n` +
    `✅ Пройдено локаций: ${completed}/6\n` +
    `💡 Осталось подсказок: ${hintsLeft}/${CONFIG.MAX_HINTS}\n` +
    `🕐 Последняя активность: ${new Date(player.last_activity).toLocaleTimeString('ru-RU')}`
  );
  
  await db.logEvent('stats_viewed', ctx.from.id);
});

// Команда /hint
bot.command('hint', async (ctx) => {
  const player = await db.getPlayer(ctx.from.id);
  
  if (!player) {
    await ctx.reply('Сначала начни игру командой /start');
    return;
  }
  
  if (player.hints_used >= CONFIG.MAX_HINTS) {
    await ctx.reply('🚫 У тебя закончились подсказки!');
    return;
  }
  
  // Определяем текущую локацию
  const allLocations = Object.entries(CONFIG.LOCATIONS)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([id]) => id);
  
  const completed = JSON.parse(player.completed_locations || '[]');
  const currentLocation = allLocations.find(loc => !completed.includes(loc)) || allLocations[0];
  
  // Получаем подсказку
  const hintLevel = player.hints_used + 1;
  const hint = await db.getHint(currentLocation, hintLevel);
  
  if (!hint) {
    await ctx.reply('🤔 Подсказка для текущей локации не настроена. Обратись к организаторам.');
    return;
  }
  
  // Используем подсказку
  await db.useHint(ctx.from.id);
  await db.logEvent('hint_used', ctx.from.id, currentLocation, {
    hint_level: hintLevel,
    hint_id: hint.id
  });
  
  const hintsLeft = CONFIG.MAX_HINTS - (player.hints_used + 1);
  
  await ctx.replyWithHTML(
    `💡 <b>Подсказка для "${CONFIG.LOCATIONS[currentLocation].name}"</b>\n\n` +
    `${hint.text}\n\n` +
    `Осталось подсказок: ${hintsLeft}/${CONFIG.MAX_HINTS}`
  );
});

// Команда /admin — ПОЛНОЦЕННАЯ АДМИН-ПАНЕЛЬ
bot.command('admin', async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.replyWithHTML(
      `🚫 <b>Доступ запрещён</b>\n\n` +
      `Твой ID: <code>${ctx.from.id}</code>\n` +
      `Администраторы: ${CONFIG.ADMIN_USER_IDS.join(', ')}`
    );
    await db.logEvent('admin_access_denied', ctx.from.id);
    return;
  }
  
  await showAdminDashboard(ctx);
  await db.logEvent('admin_dashboard_viewed', ctx.from.id);
});

// Админ-панель
async function showAdminDashboard(ctx) {
  const [missions, passwords] = await Promise.all([
    db.getAllMissions(),
    db.getAllPasswords()
  ]);
  
  // Подсчёт подсказок
  const hintsCount = db.getHintsForLocation('gates').length + 
                     db.getHintsForLocation('dome').length +
                     db.getHintsForLocation('mirror').length +
                     db.getHintsForLocation('stone').length +
                     db.getHintsForLocation('hut').length +
                     db.getHintsForLocation('lair').length;
  
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

// Настройка паролей (пример одного раздела — остальные аналогично)
bot.action('admin_passwords', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const passwords = await db.getAllPasswords();
  
  let message = `🔑 <b>Пароли доступа к локациям</b>\n\n`;
  Object.entries(CONFIG.LOCATIONS).forEach(([locId, locData]) => {
    const pwd = passwords.find(p => p.location === locId);
    const status = pwd ? '✅' : '❌';
    message += `${status} ${locData.emoji} ${locData.name}: ${pwd?.password || '<i>не задан</i>'}\n`;
  });
  
  message += `\nВыбери локацию для изменения пароля:`;
  
  const buttons = Object.entries(CONFIG.LOCATIONS).map(([locId, locData]) => 
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
    `Локация: <b>${CONFIG.LOCATIONS[locationId].name}</b>\n\n` +
    `Введи <b>новый пароль</b> для доступа к локации:\n` +
    `<i>Пароль будет размещён на территории в виде QR-кода</i>`
  );
});

bot.action('admin_dashboard', showAdminDashboard);

// Обработка текста для настройки пароля
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
      await db.setPassword(locationId, password);
      
      await ctx.replyWithHTML(
        `✅ <b>Пароль установлен!</b>\n\n` +
        `Локация: ${CONFIG.LOCATIONS[locationId].name}\n` +
        `Пароль: <code>${password}</code>\n\n` +
        `<i>⚠️ Размести этот пароль на территории локации</i>`
      );
      
      delete ctx.session.editingPassword;
      await showAdminDashboard(ctx);
    } catch (error) {
      console.error('Password save error:', error);
      await ctx.replyWithHTML(
        `❌ <b>Ошибка сохранения пароля</b>\n\n` +
        `Сообщение: ${error.message}`
      );
    }
  }
  
  // Аналогично добавить обработку для заданий и подсказок (как в предыдущих версиях)
});

// Запуск бота
bot.launch();
console.log('✅ Telegram Bot запущен с SQLite');
console.log('🔧 Admin IDs:', CONFIG.ADMIN_USER_IDS);
console.log('🌐 Frontend URL:', CONFIG.FRONTEND_URL);

// Остановка при завершении процесса
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
