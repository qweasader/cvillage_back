// config.js — продакшен конфигурация без демо-режимов

export const CONFIG = {
  // Telegram Bot Token от @BotFather
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  
  // АДМИН ID — задаётся прямо здесь (решает проблему с переменными окружения)
  ADMIN_USER_IDS: [
    131918408   // Замените на ваш Telegram I    // Дополнительные админы через запятую
  ],
  
  // Локации квеста
  LOCATIONS: {
    gates: { name: 'Врата Кибердеревни', emoji: '🚪', order: 1 },
    dome: { name: 'Купол Защиты', emoji: '🛡️', order: 2 },
    mirror: { name: 'Зеркало Истины', emoji: '🪞', order: 3 },
    stone: { name: 'Камень Пророчеств', emoji: '🔮', order: 4 },
    hut: { name: 'Хижина Хранителя', emoji: '🏠', order: 5 },
    lair: { name: 'Логово Вируса', emoji: '👾', order: 6 }
  },
  
  // Лимиты
  MAX_HINTS: 3,
  
  // URL фронтенда (для кнопки запуска)
  FRONTEND_URL: process.env.FRONTEND_URL || 'https://qweasader.github.io/cybervillage_defend/'
};
