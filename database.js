// database.js — полная база данных для квеста
import sqlite3 from 'better-sqlite3';

export class QuestDatabase {
  constructor() {
    this.db = sqlite3('quest.db');
    this.initDatabase();
  }

  initDatabase() {
    // Игроки
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT NOT NULL,
        last_name TEXT,
        team_id TEXT,
        current_location TEXT DEFAULT 'gates',
        unlocked_locations TEXT DEFAULT '["gates"]',
        completed_locations TEXT DEFAULT '[]',
        hints_used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Пароли доступа к локациям (для входа)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS location_passwords (
        location TEXT PRIMARY KEY,
        password TEXT NOT NULL
      )
    `);

    // Задания локаций
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

    // События (аудит)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        user_id INTEGER,
        location TEXT,
        data TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Индексы
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_players_id ON players(id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id)');
    
    console.log('✅ База данных инициализирована');
  }

  // ============ ИГРОКИ ============
  getPlayer(userId) {
    return this.db.prepare('SELECT * FROM players WHERE id = ?').get(userId);
  }

  createOrUpdatePlayer(userId, data) {
    const existing = this.getPlayer(userId);
    if (existing) {
      this.db.prepare(`
        UPDATE players 
        SET username = ?, first_name = ?, last_name = ?, team_id = ?, last_activity = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(data.username || null, data.first_name || '', data.last_name || null, data.team_id || null, userId);
    } else {
      this.db.prepare(`
        INSERT INTO players (id, username, first_name, last_name, team_id, current_location, unlocked_locations)
        VALUES (?, ?, ?, ?, ?, 'gates', '["gates"]')
      `).run(userId, data.username || null, data.first_name || '', data.last_name || null, data.team_id || null);
    }
    return this.getPlayer(userId);
  }

  // Разблокировать следующую локацию
  unlockNextLocation(userId) {
    const player = this.getPlayer(userId);
    if (!player) return;
    
    const allLocations = ['gates', 'dome', 'mirror', 'stone', 'hut', 'lair'];
    const unlocked = JSON.parse(player.unlocked_locations || '["gates"]');
    const completed = JSON.parse(player.completed_locations || '[]');
    
    // Находим следующую локацию после последней завершенной
    const lastCompletedIndex = Math.max(
      ...completed.map(loc => allLocations.indexOf(loc)),
      -1
    );
    
    const nextIndex = lastCompletedIndex + 1;
    if (nextIndex < allLocations.length && !unlocked.includes(allLocations[nextIndex])) {
      unlocked.push(allLocations[nextIndex]);
      this.db.prepare('UPDATE players SET unlocked_locations = ? WHERE id = ?')
        .run(JSON.stringify(unlocked), userId);
    }
  }

  // Завершить локацию
  completeLocation(userId, locationId) {
    const player = this.getPlayer(userId);
    if (!player) return;
    
    let completed = JSON.parse(player.completed_locations || '[]');
    if (!completed.includes(locationId)) {
      completed.push(locationId);
      this.db.prepare('UPDATE players SET completed_locations = ?, current_location = ? WHERE id = ?')
        .run(JSON.stringify(completed), locationId, userId);
      
      // Разблокируем следующую локацию
      this.unlockNextLocation(userId);
    }
  }

  // Использовать подсказку
  useHint(userId) {
    const player = this.getPlayer(userId);
    if (!player) return false;
    if (player.hints_used >= 3) return false;
    
    this.db.prepare('UPDATE players SET hints_used = hints_used + 1 WHERE id = ?').run(userId);
    return true;
  }

  // ============ ПАРОЛИ ДОСТУПА ============
  getPassword(location) {
    const row = this.db.prepare('SELECT password FROM location_passwords WHERE location = ?').get(location);
    return row ? row.password.trim() : null;
  }

  setPassword(location, password) {
    const cleanPassword = password.trim();
    this.db.prepare(`
      INSERT OR REPLACE INTO location_passwords (location, password)
      VALUES (?, ?)
    `).run(location, cleanPassword);
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
    // Удаляем существующую подсказку того же уровня
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
  logEvent(type, userId = null, location = null, data = {}) {
    this.db.prepare(`
      INSERT INTO events (type, user_id, location, data)
      VALUES (?, ?, ?, ?)
    `).run(type, userId, location, JSON.stringify(data));
  }

  // ============ СТАТИСТИКА ============
  getStats() {
    const totalPlayers = this.db.prepare('SELECT COUNT(*) as cnt FROM players').get().cnt;
    const completedPlayers = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM players 
      WHERE json_array_length(completed_locations) >= 6
    `).get().cnt;
    
    return { totalPlayers, completedPlayers };
  }
}
