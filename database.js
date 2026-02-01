// database.js — исправленная версия с правильной инициализацией игроков
import sqlite3 from 'better-sqlite3';

export class QuestDatabase {
  constructor() {
    this.db = sqlite3('quest.db');
    this.initDatabase();
  }

  initDatabase() {
    // Игроки — ИСПРАВЛЕНО: правильные значения по умолчанию
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
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

    // Пароли
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS location_passwords (
        location TEXT PRIMARY KEY,
        password TEXT NOT NULL
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
        user_id TEXT,
        location TEXT,
        data TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ База данных инициализирована');
  }

  // ИГРОКИ
  getPlayer(userId) {
    return this.db.prepare('SELECT * FROM players WHERE id = ?').get(String(userId));
  }

  createOrUpdatePlayer(userId, data) {
    userId = String(userId); // Гарантируем строковый тип
    const existing = this.getPlayer(userId);
    
    if (existing) {
      this.db.prepare(`
        UPDATE players 
        SET username = ?, first_name = ?, last_name = ?, team_id = ?, last_activity = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(data.username || null, data.first_name || '', data.last_name || null, data.team_id || null, userId);
    } else {
      // ИСПРАВЛЕНО: правильная инициализация для нового игрока
      this.db.prepare(`
        INSERT INTO players (id, username, first_name, last_name, team_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        userId,
        data.username || null,
        data.first_name || 'Игрок',
        data.last_name || null,
        data.team_id || null
      );
    }
    return this.getPlayer(userId);
  }

  completeLocation(userId, locationId) {
    userId = String(userId);
    const player = this.getPlayer(userId);
    if (!player) return;
    
    let completed = JSON.parse(player.completed_locations || '[]');
    if (!completed.includes(locationId)) {
      completed.push(locationId);
      this.db.prepare('UPDATE players SET completed_locations = ?, current_location = ?, last_activity = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify(completed), locationId, userId);
    }
  }

  useHint(userId) {
    userId = String(userId);
    const player = this.getPlayer(userId);
    if (!player || player.hints_used >= 3) return false;
    this.db.prepare('UPDATE players SET hints_used = hints_used + 1, last_activity = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    return true;
  }

  // ПАРОЛИ — ИСПРАВЛЕНО: всегда возвращаем строку без пробелов
  getPassword(location) {
    const row = this.db.prepare('SELECT password FROM location_passwords WHERE location = ?').get(location);
    return row ? row.password.trim() : null;
  }

  setPassword(location, password) {
    const clean = password.trim();
    this.db.prepare(`
      INSERT OR REPLACE INTO location_passwords (location, password)
      VALUES (?, ?)
    `).run(location, clean);
  }

  getAllPasswords() {
    return this.db.prepare('SELECT * FROM location_passwords').all();
  }

  // ЗАДАНИЯ
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

  // ПОДСКАЗКИ
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

  // СОБЫТИЯ
  logEvent(type, userId = null, location = null, data = {}) {
    if (userId) userId = String(userId);
    this.db.prepare(`
      INSERT INTO events (type, user_id, location, data)
      VALUES (?, ?, ?, ?)
    `).run(type, userId, location, JSON.stringify(data));
  }
}
