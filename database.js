// database.js — полная версия с защитой от конфликтов в многопользовательском режиме
import sqlite3 from 'better-sqlite3';

export class QuestDatabase {
  constructor() {
    this.dbPath = 'quest.db';
    this.initDatabase();
    this.locationGraph = this.buildLocationGraph();
  }

  // ============ ПОСТРОЕНИЕ ГРАФА ЗАВИСИМОСТЕЙ ============
  buildLocationGraph() {
    return {
      gates: { name: 'Врата Кибердеревни', emoji: '🚪', next: ['dome', 'hut', 'mirror'], order: 1 },
      dome: { name: 'Купол Защиты', emoji: '🛡️', next: ['mirror', 'stone', 'hut'], order: 2 },
      mirror: { name: 'Зеркало Истины', emoji: '🪞', next: ['stone', 'hut', 'lair'], order: 3 },
      stone: { name: 'Камень Пророчеств', emoji: '🔮', next: ['hut', 'lair'], order: 4 },
      hut: { name: 'Хижина Хранителя', emoji: '🏠', next: ['lair'], order: 5 },
      lair: { name: 'Логово Вируса', emoji: '👾', next: [], order: 6 }
    };
  }

  // ============ НАДЁЖНАЯ ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ ============
  initDatabase() {
    console.log('\n' + '='.repeat(80));
    console.log('🗄️  ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ (многопользовательский режим)');
    console.log('='.repeat(80));
    
    // Создаём базу с параметрами для многопользовательского доступа
    this.db = new sqlite3(this.dbPath, {
      verbose: console.log,
      timeout: 30000, // 30 секунд ожидания блокировки
      fileMustExist: false
    });
    
    // Настройки для надёжной работы в многопользовательском режиме
    this.db.exec('PRAGMA journal_mode = WAL;'); // Write-Ahead Logging для параллельного доступа
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 30000;'); // 30 секунд ожидания блокировки
    this.db.exec('PRAGMA temp_store = MEMORY;');
    
    console.log('✅ Настройки SQLite для многопользовательского режима применены');
    
    // Проверяем структуру таблицы teams
    const tableInfo = this.db.prepare("PRAGMA table_info(teams)").all();
    const hasRouteColumn = tableInfo.some(col => col.name === 'route');
    
    console.log('🔍 Проверка структуры таблицы teams:');
    console.log(`   route существует: ${hasRouteColumn ? '✅' : '❌'}`);
    
    if (!hasRouteColumn) {
      console.log('🔧 Добавление столбца route в существующую таблицу...');
      try {
        this.db.exec(`
          ALTER TABLE teams 
          ADD COLUMN route TEXT DEFAULT '["gates","dome","mirror","stone","hut","lair"]'
        `);
        console.log('✅ Столбец route добавлен успешно');
      } catch (e) {
        if (e.message.includes('duplicate column name')) {
          console.log('ℹ️  Столбец route уже существует');
        } else {
          console.error('❌ Ошибка добавления столбца:', e.message);
          console.log('🔄 Пересоздание таблицы teams...');
          this.db.exec('DROP TABLE IF EXISTS teams');
        }
      }
    }

    // Таблица команд
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        route TEXT NOT NULL DEFAULT '["gates","dome","mirror","stone","hut","lair"]',
        current_location TEXT DEFAULT 'gates',
        unlocked_locations TEXT DEFAULT '["gates"]',
        completed_locations TEXT DEFAULT '[]',
        hints_used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица игроков
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT,
        username TEXT,
        is_registered BOOLEAN DEFAULT 0,
        registered_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Пароли доступа
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS location_passwords (
        location TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        normalized_password TEXT NOT NULL
      )
    `);

    // Задания — с защитой от перезаписи ответа изображением
    const missionTableInfo = this.db.prepare("PRAGMA table_info(missions)").all();
    const hasNormalizedAnswer = missionTableInfo.some(col => col.name === 'normalized_answer');
    
    if (!hasNormalizedAnswer) {
      console.log('🔧 Добавление столбца normalized_answer в таблицу missions...');
      try {
        this.db.exec(`
          ALTER TABLE missions 
          ADD COLUMN normalized_answer TEXT NOT NULL DEFAULT ''
        `);
        console.log('✅ Столбец normalized_answer добавлен успешно');
      } catch (e) {
        if (e.message.includes('duplicate column name')) {
          console.log('ℹ️  Столбец normalized_answer уже существует');
        } else {
          console.error('❌ Ошибка добавления столбца normalized_answer:', e.message);
        }
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        location TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        answer TEXT NOT NULL,
        normalized_answer TEXT NOT NULL DEFAULT '',
        image_url TEXT
      )
    `);

    // Подсказки
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location TEXT NOT NULL,
        level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3),
        text TEXT NOT NULL,
        UNIQUE(location, level)
      )
    `);

    // События
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        team_id INTEGER,
        user_id TEXT,
        location TEXT,
        data TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_id) REFERENCES teams(id)
      )
    `);

    // Индексы для производительности
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_players_id ON players(id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_teams_player ON teams(player_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_team ON events(team_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_location ON events(location)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at)');
    
    console.log('✅ База данных инициализирована (многопользовательский режим)');
    
    // Проверяем, что таблицы созданы корректно
    const tables = this.db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name IN ('teams', 'players', 'missions', 'hints', 'events')
    `).all();
    
    console.log('📊 Созданные таблицы:');
    tables.forEach(t => console.log(`   • ${t.name}`));
    
    console.log('='.repeat(80) + '\n');
  }

  // ============ НАДЁЖНАЯ ЗАПИСЬ В БАЗУ ДАННЫХ С ПОВТОРНЫМИ ПОПЫТКАМИ ============
  safeRun(statement, params = [], maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return statement.run(params);
      } catch (error) {
        if (error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked')) {
          console.warn(`⚠️ Попытка ${attempt}/${maxRetries}: база данных заблокирована, повтор через ${attempt * 100}мс...`);
          // Ждём с экспоненциальной задержкой
          const delay = attempt * 100;
          const start = Date.now();
          while (Date.now() - start < delay) {
            // Активное ожидание
          }
          
          if (attempt === maxRetries) {
            console.error(`❌ КРИТИЧЕСКАЯ ОШИБКА: база данных заблокирована после ${maxRetries} попыток`);
            throw new Error(`База данных недоступна: ${error.message}`);
          }
        } else {
          console.error(`❌ Ошибка выполнения запроса:`, error.message);
          throw error;
        }
      }
    }
  }

  safeGet(statement, params = [], maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return statement.get(params);
      } catch (error) {
        if (error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked')) {
          console.warn(`⚠️ Попытка ${attempt}/${maxRetries}: база данных заблокирована (чтение), повтор через ${attempt * 50}мс...`);
          const delay = attempt * 50;
          const start = Date.now();
          while (Date.now() - start < delay) {}
          
          if (attempt === maxRetries) {
            console.error(`❌ КРИТИЧЕСКАЯ ОШИБКА: база данных заблокирована при чтении после ${maxRetries} попыток`);
            throw new Error(`База данных недоступна для чтения: ${error.message}`);
          }
        } else {
          console.error(`❌ Ошибка чтения из базы данных:`, error.message);
          throw error;
        }
      }
    }
  }

  safeAll(statement, params = [], maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return statement.all(params);
      } catch (error) {
        if (error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked')) {
          console.warn(`⚠️ Попытка ${attempt}/${maxRetries}: база данных заблокирована (чтение всех), повтор через ${attempt * 50}мс...`);
          const delay = attempt * 50;
          const start = Date.now();
          while (Date.now() - start < delay) {}
          
          if (attempt === maxRetries) {
            console.error(`❌ КРИТИЧЕСКАЯ ОШИБКА: база данных заблокирована при чтении всех после ${maxRetries} попыток`);
            throw new Error(`База данных недоступна для чтения: ${error.message}`);
          }
        } else {
          console.error(`❌ Ошибка чтения всех записей из базы данных:`, error.message);
          throw error;
        }
      }
    }
  }

  // ============ ГЕНЕРАЦИЯ УНИКАЛЬНОГО МАРШРУТА ============
  generateUniqueRoute() {
    const route = ['gates'];
    let current = 'gates';
    
    while (current !== 'lair' && route.length < 6) {
      const nextOptions = this.locationGraph[current].next;
      const available = nextOptions.filter(loc => !route.includes(loc));
      
      if (available.length === 0) break;
      
      const next = available[Math.floor(Math.random() * available.length)];
      route.push(next);
      current = next;
    }
    
    if (route[route.length - 1] !== 'lair' && !route.includes('lair')) {
      route.push('lair');
    }
    
    const allLocations = ['gates', 'dome', 'mirror', 'stone', 'hut', 'lair'];
    const missing = allLocations.filter(loc => !route.includes(loc));
    
    if (missing.length > 0) {
      missing.forEach(loc => {
        const insertPos = Math.floor(Math.random() * (route.length - 1)) + 1;
        route.splice(insertPos, 0, loc);
      });
    }
    
    console.log(`🗺️ Сгенерирован маршрут: ${route.join(' → ')}`);
    return route;
  }

  // ============ РАБОТА С КОМАНДАМИ ============
  getTeamByPlayerId(playerId) {
    console.log(`🔍 [getTeamByPlayerId] Поиск команды для игрока: ${playerId}`);
    try {
      const result = this.safeGet(
        this.db.prepare('SELECT * FROM teams WHERE player_id = ?'),
        [String(playerId)]
      );
      
      if (!result) {
        console.log(`   ❌ Команда для игрока ${playerId} не найдена`);
        return null;
      }
      
      console.log(`   ✅ Найдена команда ID ${result.id} для игрока ${playerId}`);
      return result;
    } catch (error) {
      console.error(`❌ Ошибка поиска команды для игрока ${playerId}:`, error.message);
      throw error;
    }
  }

  getTeamById(teamId) {
    try {
      return this.safeGet(
        this.db.prepare('SELECT * FROM teams WHERE id = ?'),
        [teamId]
      );
    } catch (error) {
      console.error(`❌ Ошибка поиска команды по ID ${teamId}:`, error.message);
      throw error;
    }
  }

  // ИСПРАВЛЕНО: надёжное создание команды с обработкой конфликтов и дубликатов
  createTeamForPlayer(playerId, playerName) {
    const cleanPlayerId = String(playerId);
    const cleanName = playerName.trim() || `Игрок ${cleanPlayerId.substring(0, 6)}`;
    const route = this.generateUniqueRoute();
    const routeJson = JSON.stringify(route);
    
    console.log(`🆕 Создание команды для игрока ${cleanPlayerId} с маршрутом: ${route.join(' → ')}`);
    
    try {
      // Сначала проверяем, не существует ли уже игрок
      let player = this.safeGet(
        this.db.prepare('SELECT * FROM players WHERE id = ?'),
        [cleanPlayerId]
      );
      
      if (!player) {
        // Регистрируем нового игрока
        this.safeRun(
          this.db.prepare(`
            INSERT INTO players (id, first_name, is_registered, registered_at)
            VALUES (?, ?, 1, CURRENT_TIMESTAMP)
          `),
          [cleanPlayerId, cleanName]
        );
        console.log(`   ✅ Игрок ${cleanPlayerId} зарегистрирован`);
      } else {
        console.log(`   ℹ️ Игрок ${cleanPlayerId} уже существует, обновляем имя`);
        // Обновляем имя, если игрок уже существует
        this.safeRun(
          this.db.prepare(`
            UPDATE players SET first_name = ?, last_activity = CURRENT_TIMESTAMP 
            WHERE id = ?
          `),
          [cleanName, cleanPlayerId]
        );
      }
      
      // Проверяем, не существует ли уже команда для этого игрока
      let team = this.getTeamByPlayerId(cleanPlayerId);
      
      if (!team) {
        // Создаём новую команду
        this.safeRun(
          this.db.prepare(`
            INSERT INTO teams (player_id, name, route, unlocked_locations)
            VALUES (?, ?, ?, ?)
          `),
          [cleanPlayerId, cleanName, routeJson, JSON.stringify([route[0]])]
        );
        console.log(`   ✅ Команда создана для игрока ${cleanPlayerId}`);
      } else {
        console.log(`   ℹ️ Команда для игрока ${cleanPlayerId} уже существует`);
      }
      
      // Получаем актуальные данные
      team = this.getTeamByPlayerId(cleanPlayerId);
      player = this.safeGet(
        this.db.prepare('SELECT * FROM players WHERE id = ?'),
        [cleanPlayerId]
      );
      
      if (!team || !player) {
        throw new Error(`Не удалось создать команду или игрока для ${cleanPlayerId}`);
      }
      
      this.logEvent('team_created', team.id, null, { 
        playerId: cleanPlayerId, 
        name: cleanName,
        route 
      });
      
      console.log(`✅ Команда ${team.id} успешно создана/получена для игрока ${cleanPlayerId}`);
      return { 
        player: { 
          id: cleanPlayerId, 
          first_name: cleanName, 
          is_registered: true 
        }, 
        team 
      };
    } catch (error) {
      // Обработка дубликата (игрок уже зарегистрирован)
      if (error.message.includes('UNIQUE constraint failed') || error.message.includes('SQLITE_CONSTRAINT')) {
        console.warn(`⚠️ Конфликт при регистрации игрока ${cleanPlayerId}, получаем существующие данные...`);
        const existingTeam = this.getTeamByPlayerId(cleanPlayerId);
        const existingPlayer = this.getPlayer(cleanPlayerId);
        if (existingTeam && existingPlayer) {
          return { player: existingPlayer, team: existingTeam };
        }
      }
      
      console.error(`❌ КРИТИЧЕСКАЯ ОШИБКА создания команды для игрока ${cleanPlayerId}:`, error.message);
      throw new Error(`Не удалось создать команду: ${error.message}`);
    }
  }

  getCurrentLocationForTeam(teamId) {
    const team = this.getTeamById(teamId);
    if (!team) return null;
    
    const route = JSON.parse(team.route || '["gates","dome","mirror","stone","hut","lair"]');
    const completed = JSON.parse(team.completed_locations || '[]');
    
    const currentIndex = completed.length;
    if (currentIndex >= route.length) {
      return null;
    }
    
    return route[currentIndex];
  }

  getNextLocationForTeam(teamId) {
    const team = this.getTeamById(teamId);
    if (!team) return null;
    
    const route = JSON.parse(team.route || '["gates","dome","mirror","stone","hut","lair"]');
    const completed = JSON.parse(team.completed_locations || '[]');
    
    const nextIndex = completed.length + 1;
    if (nextIndex >= route.length) {
      return null;
    }
    
    return route[nextIndex];
  }

  unlockNextLocationForTeam(teamId) {
    const team = this.getTeamById(teamId);
    if (!team) return;
    
    const route = JSON.parse(team.route || '["gates","dome","mirror","stone","hut","lair"]');
    const completed = JSON.parse(team.completed_locations || '[]');
    const unlocked = JSON.parse(team.unlocked_locations || '["gates"]');
    
    const nextIndex = completed.length;
    if (nextIndex >= route.length) return;
    
    const nextLocation = route[nextIndex];
    if (unlocked.includes(nextLocation)) return;
    
    console.log(`🔓 Разблокировка локации "${nextLocation}" для команды ${team.id}`);
    
    unlocked.push(nextLocation);
    this.safeRun(
      this.db.prepare('UPDATE teams SET unlocked_locations = ? WHERE id = ?'),
      [JSON.stringify(unlocked), teamId]
    );
  }

  completeLocationForTeam(teamId, locationId) {
    const team = this.getTeamById(teamId);
    if (!team) return;
    
    let completed = JSON.parse(team.completed_locations || '[]');
    const route = JSON.parse(team.route || '["gates","dome","mirror","stone","hut","lair"]');
    
    if (!route.includes(locationId) || completed.includes(locationId)) {
      console.warn(`⚠️ Попытка завершить недопустимую локацию ${locationId} для команды ${team.id}`);
      return;
    }
    
    const expectedLocation = route[completed.length];
    if (locationId !== expectedLocation) {
      console.warn(`⚠️ Попытка завершить локацию ${locationId}, но ожидается ${expectedLocation}`);
      return;
    }
    
    completed.push(locationId);
    this.safeRun(
      this.db.prepare(`
        UPDATE teams 
        SET completed_locations = ?, current_location = ?, last_activity = CURRENT_TIMESTAMP 
        WHERE id = ?
      `),
      [JSON.stringify(completed), locationId, teamId]
    );
    
    this.unlockNextLocationForTeam(teamId);
    
    console.log(`✅ Команда ${team.id} завершила локацию "${locationId}". Прогресс: ${completed.length}/6`);
  }

  // ============ ИГРОКИ ============
  getPlayer(userId) {
    try {
      return this.safeGet(
        this.db.prepare('SELECT * FROM players WHERE id = ?'),
        [String(userId)]
      );
    } catch (error) {
      console.error(`❌ Ошибка поиска игрока ${userId}:`, error.message);
      return null;
    }
  }

  isPlayerRegistered(userId) {
    const player = this.getPlayer(userId);
    return player && player.is_registered;
  }

  // ============ ПАРОЛИ ============
  getPassword(location) {
    console.log(`\n🔐 [getPassword] Запрос пароля для локации: "${location}"`);
    
    try {
      const row = this.safeGet(
        this.db.prepare('SELECT password, normalized_password FROM location_passwords WHERE location = ?'),
        [location]
      );
      
      if (!row) {
        console.log(`   ❌ Пароль для локации "${location}" НЕ НАЙДЕН в базе данных`);
        console.log(`   📊 Текущие пароли в БД:`);
        const allPasswords = this.safeAll(this.db.prepare('SELECT location, password FROM location_passwords'));
        allPasswords.forEach(p => console.log(`      ${p.location}: "${p.password}"`));
        return null;
      }
      
      console.log(`   ✅ Найден пароль в БД:`);
      console.log(`      Оригинал: "${row.password}"`);
      console.log(`      normalized_password: "${row.normalized_password}"`);
      
      if (!row.normalized_password || row.normalized_password.trim() === '') {
        console.log(`   ⚠️ normalized_password пустой! Пересчитываем...`);
        const recalculated = this.normalizePassword(row.password);
        console.log(`      Пересчитанный: "${recalculated}"`);
        
        this.safeRun(
          this.db.prepare(`
            UPDATE location_passwords 
            SET normalized_password = ? 
            WHERE location = ?
          `),
          [recalculated, location]
        );
        
        return { 
          original: row.password.trim(), 
          normalized: recalculated 
        };
      }
      
      return { 
        original: row.password.trim(), 
        normalized: row.normalized_password.trim() 
      };
    } catch (error) {
      console.error(`❌ Ошибка получения пароля для локации "${location}":`, error.message);
      return null;
    }
  }

  setPassword(location, password) {
    console.log(`\n🔐 [setPassword] Сохранение пароля для локации: "${location}"`);
    console.log(`   Введенный пароль: "${password}" (длина: ${password.length})`);
    
    const clean = password.trim();
    console.log(`   После trim: "${clean}" (длина: ${clean.length})`);
    
    const normalized = this.normalizePassword(clean);
    
    console.log(`   Сохраняем в БД:`);
    console.log(`      password: "${clean}"`);
    console.log(`      normalized_password: "${normalized}"`);
    
    try {
      this.safeRun(
        this.db.prepare(`
          INSERT OR REPLACE INTO location_passwords (location, password, normalized_password)
          VALUES (?, ?, ?)
        `),
        [location, clean, normalized]
      );
      
      const saved = this.safeGet(
        this.db.prepare('SELECT password, normalized_password FROM location_passwords WHERE location = ?'),
        [location]
      );
      console.log(`   ✅ Проверка сохранения:`);
      console.log(`      password в БД: "${saved.password}"`);
      console.log(`      normalized_password в БД: "${saved.normalized_password}"`);
    } catch (error) {
      console.error(`❌ Ошибка сохранения пароля для локации "${location}":`, error.message);
      throw error;
    }
  }

  getAllPasswords() {
    return this.safeAll(this.db.prepare('SELECT * FROM location_passwords'));
  }

  normalizePassword(password) {
    const original = password;
    const trimmed = password.trim();
    const lowercased = trimmed.toLowerCase();
    const normalized = lowercased.replace(/[^a-z0-9_]/g, '');
    
    console.log(`🔍 Нормализация пароля:`);
    console.log(`   Исходный: "${original}" (длина: ${original.length})`);
    console.log(`   После trim: "${trimmed}" (длина: ${trimmed.length})`);
    console.log(`   После toLowerCase: "${lowercased}" (длина: ${lowercased.length})`);
    console.log(`   После удаления спецсимволов: "${normalized}" (длина: ${normalized.length})`);
    
    return normalized;
  }

  // ============ ЗАДАНИЯ С ЗАЩИТОЙ ОТ ПЕРЕЗАПИСИ ============
  getMission(location) {
    try {
      return this.safeGet(
        this.db.prepare('SELECT * FROM missions WHERE location = ?'),
        [location]
      );
    } catch (error) {
      console.error(`❌ Ошибка получения задания для локации "${location}":`, error.message);
      return null;
    }
  }

  setMission(location, text, answer, imageUrl = null) {
    const cleanAnswer = answer.trim();
    
    // КРИТИЧЕСКАЯ ПРОВЕРКА: ответ не может быть пустым или "-"
    if (!cleanAnswer || cleanAnswer === '-') {
      const errorMsg = `❌ ОШИБКА: Недопустимый ответ "${answer}" для локации ${location}. Ответ не может быть пустым или "-".`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    
    const normalizedAnswer = this.normalizeAnswer(cleanAnswer);
    
    // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: нормализованный ответ не может быть пустым
    if (!normalizedAnswer || normalizedAnswer.trim() === '') {
      const errorMsg = `❌ ОШИБКА: Нормализованный ответ пустой для локации ${location}. Исходный ответ: "${answer}"`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    
    console.log(`\n📝 [setMission] Сохранение задания для "${location}"`);
    console.log(`   Текст: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    console.log(`   Ответ (оригинал): "${answer}"`);
    console.log(`   Ответ (после trim): "${cleanAnswer}"`);
    console.log(`   Ответ (нормализованный): "${normalizedAnswer}"`);
    console.log(`   Изображение: ${imageUrl || 'не задано'}`);
    
    try {
      this.safeRun(
        this.db.prepare(`
          INSERT OR REPLACE INTO missions (location, text, answer, normalized_answer, image_url)
          VALUES (?, ?, ?, ?, ?)
        `),
        [location, text.trim(), cleanAnswer, normalizedAnswer, imageUrl || null]
      );
      
      const saved = this.safeGet(
        this.db.prepare('SELECT answer, normalized_answer, image_url FROM missions WHERE location = ?'),
        [location]
      );
      console.log(`   ✅ Проверка сохранения:`);
      console.log(`      answer в БД: "${saved.answer}"`);
      console.log(`      normalized_answer в БД: "${saved.normalized_answer}"`);
      console.log(`      image_url в БД: "${saved.image_url || 'null'}"`);
      
      // Финальная проверка
      if (!saved.normalized_answer || saved.normalized_answer.trim() === '') {
        console.error(`   ❌ КРИТИЧЕСКАЯ ОШИБКА: normalized_answer пустой после сохранения!`);
        throw new Error(`Не удалось сохранить нормализованный ответ для локации ${location}`);
      }
    } catch (error) {
      console.error(`❌ Ошибка сохранения задания для локации "${location}":`, error.message);
      throw error;
    }
  }

  getAllMissions() {
    return this.safeAll(this.db.prepare('SELECT * FROM missions'));
  }

  normalizeAnswer(answer) {
    const original = answer;
    const trimmed = answer.trim();
    const lowercased = trimmed.toLowerCase();
    const normalized = lowercased.replace(/[^a-zа-яё0-9]/g, '');
    
    if (normalized === '') {
      console.warn(`⚠️ Предупреждение: нормализованный ответ пустой для исходного ответа: "${original}"`);
      console.warn(`   После trim: "${trimmed}"`);
      console.warn(`   После toLowerCase: "${lowercased}"`);
    }
    
    console.log(`🔍 Нормализация ответа:`);
    console.log(`   Исходный: "${original}" (длина: ${original.length})`);
    console.log(`   После trim: "${trimmed}" (длина: ${trimmed.length})`);
    console.log(`   После toLowerCase: "${lowercased}" (длина: ${lowercased.length})`);
    console.log(`   После удаления спецсимволов: "${normalized}" (длина: ${normalized.length})`);
    
    return normalized;
  }

  // ============ ПОДСКАЗКИ ============
  getHint(location, level) {
    try {
      return this.safeGet(
        this.db.prepare(`
          SELECT * FROM hints 
          WHERE location = ? AND level <= ?
          ORDER BY level DESC
          LIMIT 1
        `),
        [location, level]
      );
    } catch (error) {
      console.error(`❌ Ошибка получения подсказки для локации "${location}":`, error.message);
      return null;
    }
  }

  createHint(location, level, text) {
    try {
      this.safeRun(
        this.db.prepare('DELETE FROM hints WHERE location = ? AND level = ?'),
        [location, level]
      );
      
      this.safeRun(
        this.db.prepare(`
          INSERT INTO hints (location, level, text)
          VALUES (?, ?, ?)
        `),
        [location, level, text.trim()]
      );
    } catch (error) {
      console.error(`❌ Ошибка создания подсказки для локации "${location}":`, error.message);
      throw error;
    }
  }

  getHintsForLocation(location) {
    return this.safeAll(
      this.db.prepare('SELECT * FROM hints WHERE location = ? ORDER BY level'),
      [location]
    );
  }

  // ============ СОБЫТИЯ ============
  logEvent(type, teamId = null, location = null, data = {}) {
    try {
      this.safeRun(
        this.db.prepare(`
          INSERT INTO events (type, team_id, user_id, location, data)
          VALUES (?, ?, ?, ?, ?)
        `),
        [
          type, 
          teamId, 
          data.userId || null, 
          location, 
          JSON.stringify(data)
        ]
      );
    } catch (error) {
      // Не критично, если не удалось записать событие
      console.warn(`⚠️ Не удалось записать событие "${type}":`, error.message);
    }
  }

  // ============ СТАТИСТИКА ============
  getStats() {
    try {
      const totalTeams = this.safeGet('SELECT COUNT(*) as cnt FROM teams').cnt;
      const completedTeams = this.safeGet(`
        SELECT COUNT(*) as cnt FROM teams 
        WHERE json_array_length(completed_locations) >= 6
      `).cnt;
      
      const totalPlayers = this.safeGet('SELECT COUNT(*) as cnt FROM players WHERE is_registered = 1').cnt;
      
      return { totalTeams, completedTeams, totalPlayers };
    } catch (error) {
      console.error('❌ Ошибка получения статистики:', error.message);
      return { totalTeams: 0, completedTeams: 0, totalPlayers: 0 };
    }
  }
}
