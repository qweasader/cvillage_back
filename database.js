// database.js — исправленная версия с защитой от перезаписи ответа изображением
import sqlite3 from 'better-sqlite3';

export class QuestDatabase {
  constructor() {
    this.db = sqlite3('quest.db');
    this.initDatabase();
    this.locationGraph = this.buildLocationGraph();
  }

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

  initDatabase() {
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
        console.error('❌ Ошибка добавления столбца:', e.message);
        console.log('🔄 Пересоздание таблицы teams...');
        this.db.exec('DROP TABLE IF EXISTS teams');
      }
    }

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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS location_passwords (
        location TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        normalized_password TEXT NOT NULL
      )
    `);

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
        console.error('❌ Ошибка добавления столбца normalized_answer:', e.message);
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location TEXT NOT NULL,
        level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3),
        text TEXT NOT NULL,
        UNIQUE(location, level)
      )
    `);

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

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_players_id ON players(id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_teams_player ON teams(player_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_team ON events(team_id)');
    
    console.log('✅ База данных инициализирована (упрощённая регистрация)');
  }

  getTeamByPlayerId(playerId) {
    return this.db.prepare('SELECT * FROM teams WHERE player_id = ?').get(String(playerId));
  }

  getTeamById(teamId) {
    return this.db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  }

  createTeamForPlayer(playerId, playerName) {
    const cleanName = playerName.trim() || `Команда ${playerId.substring(0, 6)}`;
    const route = this.generateUniqueRoute();
    const routeJson = JSON.stringify(route);
    
    console.log(`🆕 Создание команды для игрока ${playerId} с маршрутом: ${route.join(' → ')}`);
    
    this.db.prepare(`
      INSERT OR REPLACE INTO players (id, first_name, is_registered, registered_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    `).run(String(playerId), cleanName);
    
    this.db.prepare(`
      INSERT INTO teams (player_id, name, route, unlocked_locations)
      VALUES (?, ?, ?, ?)
    `).run(
      String(playerId), 
      cleanName, 
      routeJson,
      JSON.stringify([route[0]])
    );
    
    const team = this.getTeamByPlayerId(playerId);
    this.logEvent('team_created', team.id, null, { 
      playerId, 
      name: cleanName,
      route 
    });
    return { player: { id: playerId, first_name: cleanName, is_registered: true }, team };
  }

  generateTeamCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
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
    this.db.prepare('UPDATE teams SET unlocked_locations = ? WHERE id = ?')
      .run(JSON.stringify(unlocked), teamId);
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
    this.db.prepare(`
      UPDATE teams 
      SET completed_locations = ?, current_location = ?, last_activity = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(JSON.stringify(completed), locationId, teamId);
    
    this.unlockNextLocationForTeam(teamId);
    
    console.log(`✅ Команда ${team.id} завершила локацию "${locationId}". Прогресс: ${completed.length}/6`);
  }

  getPlayer(userId) {
    return this.db.prepare('SELECT * FROM players WHERE id = ?').get(String(userId));
  }

  isPlayerRegistered(userId) {
    const player = this.getPlayer(userId);
    return player && player.is_registered;
  }

  getPassword(location) {
    console.log(`\n🔐 [getPassword] Запрос пароля для локации: "${location}"`);
    
    const row = this.db.prepare('SELECT password, normalized_password FROM location_passwords WHERE location = ?').get(location);
    
    if (!row) {
      console.log(`   ❌ Пароль для локации "${location}" НЕ НАЙДЕН в базе данных`);
      console.log(`   📊 Текущие пароли в БД:`);
      const allPasswords = this.db.prepare('SELECT location, password FROM location_passwords').all();
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
      
      this.db.prepare(`
        UPDATE location_passwords 
        SET normalized_password = ? 
        WHERE location = ?
      `).run(recalculated, location);
      
      return { 
        original: row.password.trim(), 
        normalized: recalculated 
      };
    }
    
    return { 
      original: row.password.trim(), 
      normalized: row.normalized_password.trim() 
    };
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
    
    this.db.prepare(`
      INSERT OR REPLACE INTO location_passwords (location, password, normalized_password)
      VALUES (?, ?, ?)
    `).run(location, clean, normalized);
    
    const saved = this.db.prepare('SELECT password, normalized_password FROM location_passwords WHERE location = ?').get(location);
    console.log(`   ✅ Проверка сохранения:`);
    console.log(`      password в БД: "${saved.password}"`);
    console.log(`      normalized_password в БД: "${saved.normalized_password}"`);
  }

  getAllPasswords() {
    return this.db.prepare('SELECT * FROM location_passwords').all();
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

  // ============ ЗАДАНИЯ С ЗАЩИТОЙ ОТ ПЕРЕЗАПИСИ ОТВЕТА ============
  getMission(location) {
    return this.db.prepare('SELECT * FROM missions WHERE location = ?').get(location);
  }

  // ИСПРАВЛЕНО: добавлена проверка на недопустимые ответы
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
    
    this.db.prepare(`
      INSERT OR REPLACE INTO missions (location, text, answer, normalized_answer, image_url)
      VALUES (?, ?, ?, ?, ?)
    `).run(location, text.trim(), cleanAnswer, normalizedAnswer, imageUrl || null);
    
    const saved = this.db.prepare('SELECT answer, normalized_answer, image_url FROM missions WHERE location = ?').get(location);
    console.log(`   ✅ Проверка сохранения:`);
    console.log(`      answer в БД: "${saved.answer}"`);
    console.log(`      normalized_answer в БД: "${saved.normalized_answer}"`);
    console.log(`      image_url в БД: "${saved.image_url || 'null'}"`);
    
    // Финальная проверка
    if (!saved.normalized_answer || saved.normalized_answer.trim() === '') {
      console.error(`   ❌ КРИТИЧЕСКАЯ ОШИБКА: normalized_answer пустой после сохранения!`);
      throw new Error(`Не удалось сохранить нормализованный ответ для локации ${location}`);
    }
  }

  getAllMissions() {
    return this.db.prepare('SELECT * FROM missions').all();
  }

  // УЛУЧШЕННАЯ НОРМАЛИЗАЦИЯ ОТВЕТОВ
  normalizeAnswer(answer) {
    const original = answer;
    const trimmed = answer.trim();
    const lowercased = trimmed.toLowerCase();
    // Поддержка кириллицы и латиницы, удаление ВСЕХ спецсимволов кроме букв и цифр
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

  getHint(location, level) {
    return this.db.prepare(`
      SELECT * FROM hints 
      WHERE location = ? AND level <= ?
      ORDER BY level DESC
      LIMIT 1
    `).get(location, level);
  }

  createHint(location, level, text) {
    this.db.prepare('DELETE FROM hints WHERE location = ? AND level = ?').run(location, level);
    this.db.prepare(`
      INSERT INTO hints (location, level, text)
      VALUES (?, ?, ?)
    `).run(location, level, text.trim());
  }

  getHintsForLocation(location) {
    return this.db.prepare('SELECT * FROM hints WHERE location = ? ORDER BY level').all(location);
  }

  logEvent(type, teamId = null, location = null, data = {}) {
    this.db.prepare(`
      INSERT INTO events (type, team_id, user_id, location, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      type, 
      teamId, 
      data.userId || null, 
      location, 
      JSON.stringify(data)
    );
  }

  getStats() {
    const totalTeams = this.db.prepare('SELECT COUNT(*) as cnt FROM teams').get().cnt;
    const completedTeams = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM teams 
      WHERE json_array_length(completed_locations) >= 6
    `).get().cnt;
    
    const totalPlayers = this.db.prepare('SELECT COUNT(*) as cnt FROM players WHERE is_registered = 1').get().cnt;
    
    return { totalTeams, completedTeams, totalPlayers };
  }
}
