// server.js — HTTP сервер для обработки запросов от фронтенда
import http from 'http';
import url from 'url';
import { Database } from './database.js';

const db = new Database();
const PORT = process.env.PORT || 3000;

// Валидация Telegram initData (упрощённая для демо)
function validateInitData(initData) {
  // В продакшене: проверка HMAC-SHA256
  // Для демо: просто проверяем наличие
  return initData && initData.includes('user=') && initData.includes('hash=');
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  // Preflight запросы
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Парсинг URL
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  
  // Получение initData из заголовков
  const initData = req.headers['x-telegram-init-data'] || 
                   req.headers['x-telegram-init-data'] || '';
  
  try {
    // ============ ПРОВЕРКА ПАРОЛЯ ЛОКАЦИИ ============
    if (pathname === '/check-password' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          const { location, password } = JSON.parse(body);
          
          console.log(`🔍 Проверка пароля: локация=${location}, пароль="${password}"`);
          
          // Валидация
          if (!location || !password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Location and password required' }));
            return;
          }
          
          // Получение пароля из БД (уже без пробелов благодаря getPassword())
          const correctPassword = db.getPassword(location);
          
          console.log(`🔑 Пароль в БД: "${correctPassword}"`);
          console.log(`🔑 Введённый пароль: "${password.trim()}"`);
          
          // ТОЧНОЕ СРАВНЕНИЕ БЕЗ ПРОБЕЛОВ
          const isCorrect = correctPassword && password.trim() === correctPassword;
          
          if (isCorrect) {
            // Логирование успешного доступа
            const userId = initData.includes('id=') ? 
              initData.split('id=')[1].split('&')[0] : 'unknown';
            
            db.logEvent('location_accessed', userId, location, { password: '***' });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: true, 
              message: 'Пароль верный!' 
            }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              success: false, 
              message: 'Неверный пароль! Проверь регистр и пробелы.' 
            }));
          }
        } catch (error) {
          console.error('❌ Ошибка проверки пароля:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
      return;
    }
    
    // ============ ПОЛУЧЕНИЕ ЗАДАНИЯ ============
    if (pathname === '/get-mission' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          const { location } = JSON.parse(body);
          
          if (!location) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Location required' }));
            return;
          }
          
          const mission = db.getMission(location);
          
          if (!mission) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              error: 'mission_not_found',
              message: 'Задание ещё не настроено администратором'
            }));
            return;
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true,
            mission: {
              text: mission.text,
              answer: mission.answer,
              imageUrl: mission.image_url
            }
          }));
        } catch (error) {
          console.error('❌ Ошибка получения задания:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
      return;
    }
    
    // ============ ЗАПРОС ПОДСКАЗКИ ============
    if (pathname === '/request-hint' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          const { location, hintLevel = 1 } = JSON.parse(body);
          
          if (!location) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Location required' }));
            return;
          }
          
          // Получаем игрока из initData
          const userId = initData.includes('id=') ? 
            initData.split('id=')[1].split('&')[0] : null;
          
          if (!userId) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'User ID required' }));
            return;
          }
          
          // Проверяем лимит подсказок
          const player = db.getPlayer(userId);
          if (!player) {
            db.createOrUpdatePlayer(userId, { first_name: 'Player' });
          }
          
          if (player && player.hints_used >= 3) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              error: 'no_hints_left',
              hintsUsed: player.hints_used,
              maxHints: 3
            }));
            return;
          }
          
          // Получаем подсказку
          const hint = db.getHint(location, hintLevel);
          
          if (!hint) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              error: 'not_found',
              message: 'Подсказка не найдена'
            }));
            return;
          }
          
          // Используем подсказку
          db.useHint(userId);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true,
            text: hint.text,
            hintsUsed: (player?.hints_used || 0) + 1,
            hintsLeft: 3 - ((player?.hints_used || 0) + 1),
            maxHints: 3
          }));
        } catch (error) {
          console.error('❌ Ошибка запроса подсказки:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
      return;
    }
    
    // ============ ИГРОВОЕ СОБЫТИЕ ============
    if (pathname === '/game-event' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          const { eventType, eventData, userId } = JSON.parse(body);
          
          if (!userId || !eventType) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'User ID and event type required' }));
            return;
          }
          
          // Обработка событий
          switch (eventType) {
            case 'quest_started':
              db.createOrUpdatePlayer(userId, {
                username: eventData.username,
                first_name: eventData.firstName,
                last_name: eventData.lastName,
                team_id: eventData.teamId
              });
              break;
              
            case 'location_completed':
              if (!eventData.location) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Location required' }));
                return;
              }
              db.completeLocation(userId, eventData.location);
              break;
          }
          
          db.logEvent(eventType, userId, eventData?.location, eventData);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, eventType }));
        } catch (error) {
          console.error('❌ Ошибка обработки события:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
      return;
    }
    
    // Неизвестный эндпоинт
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (error) {
    console.error('❌ Server error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

server.listen(PORT, () => {
  console.log(`✅ HTTP Server запущен на порту ${PORT}`);
  console.log(`🌐 Frontend должен отправлять запросы на: https://ваш-бот.railway.app`);
});
