// database.js — с детальным логированием каждого этапа
import sqlite3 from 'better-sqlite3';

export class QuestDatabase {
  constructor() {
    this.db = sqlite3('quest.db');
    this.initDatabase();
  }

  initDatabase() {
    console.log('\n' + '='.repeat(80));
    console.log('🗄️  ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ');
    console.log('='.repeat(80));
    
    // Проверяем структуру существующей таблицы
    const tableInfo = this.db.prepare("PRAGMA table_info(location_passwords)").all();
    const hasNormalizedColumn = tableInfo.some(col => col.name === 'normalized_password');
    
    console.log('🔍 Проверка структуры таблицы location_passwords:');
    tableInfo.forEach(col => {
      console.log(`   • ${col.name} (тип: ${col.type}, notnull: ${col.notnull})`);
    });
    console.log(`   normalized_password существует: ${hasNormalizedColumn ? '✅ ДА' : '❌ НЕТ'}`);
    
    // Если столбца нет — добавляем его
    if (!hasNormalizedColumn) {
      console.log('\n🔧 Добавление столбца normalized_password в существующую таблицу...');
      try {
        this.db.exec(`
          ALTER TABLE location_passwords 
          ADD COLUMN normalized_password TEXT NOT NULL DEFAULT ''
        `);
        console.log('✅ Столбец normalized_password добавлен успешно');
      } catch (e) {
        console.error('❌ Ошибка добавления столбца:', e.message);
        console.log('🔄 Пересоздание таблицы location_passwords...');
        this.db.exec('DROP TABLE IF EXISTS location_passwords');
      }
    }

    // Создание всех таблиц
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS location_passwords (
        location TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        normalized_password TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        location TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        answer TEXT NOT NULL,
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

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_team ON events(team_id)');
    
    console.log('\n✅ База данных инициализирована');
    
    // Выводим все пароли из БД для проверки
    console.log('\n📊 ТЕКУЩИЕ ПАРОЛИ В БАЗЕ ДАННЫХ:');
    const passwords = this.db.prepare('SELECT location, password, normalized_password FROM location_passwords').all();
    if (passwords.length === 0) {
      console.log('   ⚠️  Нет сохраненных паролей');
    } else {
      passwords.forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.location}:`);
        console.log(`      Оригинал: "${p.password}" (длина: ${p.password.length})`);
        console.log(`      normalized: "${p.normalized_password}" (длина: ${p.normalized_password.length})`);
      });
    }
    console.log('='.repeat(80) + '\n');
  }

  // ============ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ============
  normalizePassword(password) {
    console.log(`\n🔍 [normalizePassword] Начало нормализации:`);
    console.log(`   Входной пароль: "${password}" (длина: ${password.length})`);
    
    const original = password;
    const trimmed = password.trim();
    console.log(`   После trim: "${trimmed}" (длина: ${trimmed.length})`);
    
    const lowercased = trimmed.toLowerCase();
    console.log(`   После toLowerCase: "${lowercased}" (длина: ${lowercased.length})`);
    
    const normalized = lowercased.replace(/[^a-z0-9_]/g, '');
    console.log(`   После удаления спецсимволов: "${normalized}" (длина: ${normalized.length})`);
    console.log(`   Результат нормализации: "${normalized}"`);
    
    return normalized;
  }

  // ============ ПАРОЛИ — С МАКСИМАЛЬНЫМ ЛОГИРОВАНИЕМ ============
  getPassword(location) {
    console.log(`\n🔐 [getPassword] Запрос пароля для локации: "${location}"`);
    
    // Выполняем запрос к БД
    const queryStart = Date.now();
    const row = this.db.prepare('SELECT password, normalized_password FROM location_passwords WHERE location = ?').get(location);
    const queryTime = Date.now() - queryStart;
    
    console.log(`   ⏱️  Время выполнения запроса: ${queryTime}мс`);
    
    if (!row) {
      console.error(`   ❌ Пароль для локации "${location}" НЕ НАЙДЕН в базе данных!`);
      
      // Выводим все пароли для отладки
      console.log(`   📊 Все пароли в БД:`);
      const allPasswords = this.db.prepare('SELECT location, password FROM location_passwords').all();
      if (allPasswords.length === 0) {
        console.log(`      ⚠️  База данных пуста!`);
      } else {
        allPasswords.forEach(p => console.log(`      • ${p.location}: "${p.password}"`));
      }
      
      return null;
    }
    
    console.log(`   ✅ Найден пароль в БД:`);
    console.log(`      password: "${row.password}" (длина: ${row.password.length})`);
    console.log(`      normalized_password: "${row.normalized_password}" (длина: ${row.normalized_password.length})`);
    
    // Если normalized_password пустой — пересчитываем
    if (!row.normalized_password || row.normalized_password.trim() === '') {
      console.warn(`   ⚠️ normalized_password пустой! Пересчитываем...`);
      const recalculated = this.normalizePassword(row.password);
      console.log(`      Пересчитанный: "${recalculated}"`);
      
      // Обновляем в БД
      this.db.prepare(`
        UPDATE location_passwords 
        SET normalized_password = ? 
        WHERE location = ?
      `).run(recalculated, location);
      
      console.log(`      ✅ normalized_password обновлен в БД`);
      
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
    console.log(`\n🔐 [setPassword] Сохранение пароля`);
    console.log(`   Локация: "${location}"`);
    console.log(`   Введенный пароль: "${password}" (длина: ${password.length})`);
    
    const clean = password.trim();
    console.log(`   После trim: "${clean}" (длина: ${clean.length})`);
    
    // Нормализация
    const normalized = this.normalizePassword(clean);
    
    console.log(`\n💾 Сохранение в БД:`);
    console.log(`   location: "${location}"`);
    console.log(`   password: "${clean}"`);
    console.log(`   normalized_password: "${normalized}"`);
    
    // Сохраняем в БД
    const saveStart = Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO location_passwords (location, password, normalized_password)
      VALUES (?, ?, ?)
    `).run(location, clean, normalized);
    const saveTime = Date.now() - saveStart;
    
    console.log(`   ⏱️  Время сохранения: ${saveTime}мс`);
    
    // Проверяем, что сохранилось
    const saved = this.db.prepare('SELECT password, normalized_password FROM location_passwords WHERE location = ?').get(location);
    console.log(`\n✅ Проверка сохранения:`);
    console.log(`   password в БД: "${saved.password}" (длина: ${saved.password.length})`);
    console.log(`   normalized_password в БД: "${saved.normalized_password}" (длина: ${saved.normalized_password.length})`);
    
    // Сравниваем сохраненные значения с ожидаемыми
    if (saved.password === clean && saved.normalized_password === normalized) {
      console.log(`   ✅ Сохранение прошло успешно!`);
    } else {
      console.error(`   ❌ ОШИБКА: сохраненные значения не совпадают с ожидаемыми!`);
      console.error(`      Ожидалось password: "${clean}"`);
      console.error(`      Получено password: "${saved.password}"`);
      console.error(`      Ожидалось normalized: "${normalized}"`);
      console.error(`      Получено normalized: "${saved.normalized_password}"`);
    }
    
    // Выводим все пароли после сохранения
    console.log(`\n📊 Все пароли в БД после сохранения:`);
    const allPasswords = this.db.prepare('SELECT location, password, normalized_password FROM location_passwords').all();
    allPasswords.forEach(p => {
      console.log(`   • ${p.location}: "${p.password}" → normalized: "${p.normalized_password}"`);
    });
  }

  getAllPasswords() {
    return this.db.prepare('SELECT * FROM location_passwords').all();
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
