// database.js — полная переработка с детальным логированием
import sqlite3 from 'better-sqlite3';

export class QuestDatabase {
  constructor() {
    this.db = sqlite3('quest.db');
    this.initDatabase();
  }

  initDatabase() {
    // Проверяем структуру существующей таблицы
    const tableInfo = this.db.prepare("PRAGMA table_info(location_passwords)").all();
    const hasNormalizedColumn = tableInfo.some(col => col.name === 'normalized_password');
    
    console.log('🔍 Проверка структуры таблицы location_passwords:');
    console.log(`   Столбцы: ${tableInfo.map(col => col.name).join(', ')}`);
    console.log(`   normalized_password существует: ${hasNormalizedColumn ? '✅' : '❌'}`);
    
    // Если столбца нет — добавляем его
    if (!hasNormalizedColumn) {
      console.log('🔧 Добавление столбца normalized_password в существующую таблицу...');
      try {
        this.db.exec(`
          ALTER TABLE location_passwords 
          ADD COLUMN normalized_password TEXT NOT NULL DEFAULT ''
        `);
        console.log('✅ Столбец normalized_password добавлен успешно');
      } catch (e) {
        console.error('❌ Ошибка добавления столбца:', e.message);
        // Если не удалось добавить — пересоздаем таблицу
        console.log('🔄 Пересоздание таблицы location_passwords...');
        this.db.exec('DROP TABLE IF EXISTS location_passwords');
      }
    }

    // Команды
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        current_location TEXT DEFAULT 'gates',
        unlocked_locations TEXT DEFAULT '["gates"]',
        completed_locations TEXT DEFAULT '[]',
        hints_used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Игроки
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        team_id INTEGER NOT NULL,
        username TEXT,
        first_name TEXT NOT NULL,
        last_name TEXT,
        is_registered BOOLEAN DEFAULT 0,
        registered_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_id) REFERENCES teams(id)
      )
    `);

    // Пароли доступа — С ОБЯЗАТЕЛЬНЫМ СТОЛБЦОМ normalized_password
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS location_passwords (
        location TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        normalized_password TEXT NOT NULL
      )
    `);

    // Задания
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        location TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        answer TEXT NOT NULL,
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

    // Индексы
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_team ON events(team_id)');
    
    console.log('✅ База данных инициализирована (командный режим)');
    console.log('📊 Текущее состояние паролей:');
    const passwords = this.db.prepare('SELECT location, password, normalized_password FROM location_passwords').all();
    passwords.forEach(p => {
      console.log(`   ${p.location}: "${p.password}" → normalized: "${p.normalized_password}"`);
    });
  }

  // ============ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ДЛЯ ОТЛАДКИ ============
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

  // ============ КОМАНДЫ ============
  getTeamByCode(code) {
    return this.db.prepare('SELECT * FROM teams WHERE code = ?').get(code.toUpperCase().trim());
  }

  getTeamById(teamId) {
    return this.db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  }

  createTeam(code, name) {
    const teamCode = code || this.generateTeamCode();
    const cleanName = name.trim() || `Команда ${teamCode}`;
    
    this.db.prepare(`
      INSERT INTO teams (code, name, unlocked_locations)
      VALUES (?, ?, '["gates"]')
    `).run(teamCode.toUpperCase(), cleanName);
    
    const team = this.getTeamByCode(teamCode);
    this.logEvent('team_created', team.id, null, { code: teamCode, name: cleanName });
    return team;
  }

  generateTeamCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (this.getTeamByCode(code)) {
      return this.generateTeamCode();
    }
    return code;
  }

  // ============ ИГРОКИ ============
  getPlayer(userId) {
    return this.db.prepare('SELECT * FROM players WHERE id = ?').get(String(userId));
  }

  registerPlayer(userId, teamCode, playerName = null) {
    let team = this.getTeamByCode(teamCode);
    if (!team) {
      team = this.createTeam(teamCode, `Команда ${teamCode}`);
    }
    
    const existing = this.getPlayer(userId);
    const cleanName = (playerName || '').trim() || 'Игрок';
    
    if (existing) {
      this.db.prepare(`
        UPDATE players 
        SET team_id = ?, first_name = ?, is_registered = 1, registered_at = CURRENT_TIMESTAMP, last_activity = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(team.id, cleanName, userId);
    } else {
      this.db.prepare(`
        INSERT INTO players (id, team_id, first_name, is_registered, registered_at)
        VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
      `).run(String(userId), team.id, cleanName);
    }
    
    const player = this.getPlayer(userId);
    this.logEvent('player_registered', team.id, null, { 
      userId, 
      playerName: cleanName,
      teamCode: team.code,
      teamName: team.name
    });
    
    return { player, team };
  }

  isPlayerRegistered(userId) {
    const player = this.getPlayer(userId);
    return player && player.is_registered;
  }

  completeLocationForTeam(teamId, locationId) {
    const team = this.getTeamById(teamId);
    if (!team) return;
    
    let completed = JSON.parse(team.completed_locations || '[]');
    if (!completed.includes(locationId)) {
      completed.push(locationId);
      this.db.prepare(`
        UPDATE teams 
        SET completed_locations = ?, current_location = ?, last_activity = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).run(JSON.stringify(completed), locationId, teamId);
      
      this.unlockNextLocationForTeam(teamId);
    }
  }

  unlockNextLocationForTeam(teamId) {
    const team = this.getTeamById(teamId);
    if (!team) return;
    
    const allLocations = ['gates', 'dome', 'mirror', 'stone', 'hut', 'lair'];
    const unlocked = JSON.parse(team.unlocked_locations || '["gates"]');
    const completed = JSON.parse(team.completed_locations || '[]');
    
    const lastCompletedIndex = Math.max(
      ...completed.map(loc => allLocations.indexOf(loc)),
      -1
    );
    
    const nextIndex = lastCompletedIndex + 1;
    if (nextIndex < allLocations.length && !unlocked.includes(allLocations[nextIndex])) {
      unlocked.push(allLocations[nextIndex]);
      this.db.prepare('UPDATE teams SET unlocked_locations = ? WHERE id = ?')
        .run(JSON.stringify(unlocked), teamId);
    }
  }

  useHintForTeam(teamId) {
    const team = this.getTeamById(teamId);
    if (!team || team.hints_used >= 3) return false;
    
    this.db.prepare('UPDATE teams SET hints_used = hints_used + 1, last_activity = CURRENT_TIMESTAMP WHERE id = ?')
      .run(teamId);
    return true;
  }

  getTeamMembers(teamId) {
    return this.db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY registered_at').all(teamId);
  }

  // ============ ПАРОЛИ — ПОЛНОСТЬЮ ПЕРЕДЕЛАНАЯ ВЕРСИЯ С ЛОГИРОВАНИЕМ ============
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
    
    // Если normalized_password пустой — пересчитываем
    if (!row.normalized_password || row.normalized_password.trim() === '') {
      console.log(`   ⚠️ normalized_password пустой! Пересчитываем...`);
      const recalculated = this.normalizePassword(row.password);
      console.log(`      Пересчитанный: "${recalculated}"`);
      
      // Обновляем в БД
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
    
    // Нормализация: приводим к нижнему регистру и удаляем все не-буквенно-цифровые символы кроме подчеркивания
    const normalized = this.normalizePassword(clean);
    
    console.log(`   Сохраняем в БД:`);
    console.log(`      password: "${clean}"`);
    console.log(`      normalized_password: "${normalized}"`);
    
    this.db.prepare(`
      INSERT OR REPLACE INTO location_passwords (location, password, normalized_password)
      VALUES (?, ?, ?)
    `).run(location, clean, normalized);
    
    // Проверяем, что сохранилось
    const saved = this.db.prepare('SELECT password, normalized_password FROM location_passwords WHERE location = ?').get(location);
    console.log(`   ✅ Проверка сохранения:`);
    console.log(`      password в БД: "${saved.password}"`);
    console.log(`      normalized_password в БД: "${saved.normalized_password}"`);
  }

  getAllPasswords() {
    return this.db.prepare('SELECT * FROM location_passwords').all();
  }

  // ============ ЗАДАНИЯ ============
  getMission(location) {
    return this.db.prepare('SELECT * FROM missions WHERE location = ?').get(location);
  }

  setMission(location, text, answer, imageUrl = null) {
    this.db.prepare(`
      INSERT OR REPLACE INTO missions (location, text, answer, image_url)
      VALUES (?, ?, ?, ?)
    `).run(location, text.trim(), answer.trim(), imageUrl || null);
  }

  getAllMissions() {
    return this.db.prepare('SELECT * FROM missions').all();
  }

  // ============ ПОДСКАЗКИ ============
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

  // ============ СОБЫТИЯ ============
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

  // ============ СТАТИСТИКА ============
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
