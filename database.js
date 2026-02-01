// database.js — единая БД для бота и сервера
import sqlite3 from 'better-sqlite3';

export class Database {
  constructor() {
    this.sqlite = sqlite3('database.sqlite');
    this.initDatabase();
  }
  
  initDatabase() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT NOT NULL,
        last_name TEXT,
        team_id TEXT,
        hints_used INTEGER DEFAULT 0 CHECK (hints_used <= 3),
        completed_locations TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        location TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        answer TEXT NOT NULL,
        image_url TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS location_passwords (
        location TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS hints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location TEXT NOT NULL,
        hint_level INTEGER NOT NULL CHECK (hint_level BETWEEN 1 AND 3),
        text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(location, hint_level)
      )
    `);
    
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        user_id INTEGER,
        location TEXT,
        data TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    this.sqlite.exec('CREATE INDEX IF NOT EXISTS idx_players_id ON players(id)');
    this.sqlite.exec('CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id)');
    console.log('✅ Database initialized');
  }
  
  // Игроки
  getPlayer(userId) {
    return this.sqlite.prepare('SELECT * FROM players WHERE id = ?').get(userId);
  }
  
  createOrUpdatePlayer(userId, data) {
    const existing = this.getPlayer(userId);
    if (existing) {
      this.sqlite.prepare(`
        UPDATE players 
        SET username = ?, first_name = ?, last_name = ?, team_id = ?, last_activity = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(data.username || null, data.first_name || '', data.last_name || null, data.team_id || null, userId);
    } else {
      this.sqlite.prepare(`
        INSERT INTO players (id, username, first_name, last_name, team_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, data.username || null, data.first_name || '', data.last_name || null, data.team_id || null);
    }
    return this.getPlayer(userId);
  }
  
  useHint(userId) {
    const player = this.getPlayer(userId);
    if (!player) throw new Error('Player not found');
    if (player.hints_used >= 3) return false;
    this.sqlite.prepare('UPDATE players SET hints_used = hints_used + 1 WHERE id = ?').run(userId);
    return true;
  }
  
  completeLocation(userId, locationId) {
    const player = this.getPlayer(userId);
    if (!player) throw new Error('Player not found');
    let completed = JSON.parse(player.completed_locations || '[]');
    if (!completed.includes(locationId)) {
      completed.push(locationId);
      this.sqlite.prepare('UPDATE players SET completed_locations = ? WHERE id = ?').run(JSON.stringify(completed), userId);
    }
  }
  
  // Задания
  getMission(location) {
    return this.sqlite.prepare('SELECT * FROM missions WHERE location = ?').get(location);
  }
  
  setMission(location, missionData) {
    const existing = this.getMission(location);
    if (existing) {
      this.sqlite.prepare(`
        UPDATE missions 
        SET text = ?, answer = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE location = ?
      `).run(missionData.text, missionData.answer, missionData.imageUrl || null, location);
    } else {
      this.sqlite.prepare(`
        INSERT INTO missions (location, text, answer, image_url)
        VALUES (?, ?, ?, ?)
      `).run(location, missionData.text, missionData.answer, missionData.imageUrl || null);
    }
    return this.getMission(location);
  }
  
  getAllMissions() {
    return this.sqlite.prepare('SELECT * FROM missions ORDER BY location').all();
  }
  
  // Пароли (КРИТИЧЕСКИ ВАЖНО: точное сравнение без пробелов)
  getPassword(location) {
    const row = this.sqlite.prepare('SELECT password FROM location_passwords WHERE location = ?').get(location);
    return row ? row.password.trim() : null; // Убираем пробелы!
  }
  
  setPassword(location, password) {
    // Сохраняем пароль без лишних пробелов
    const cleanPassword = password.trim();
    
    const existing = this.sqlite.prepare('SELECT 1 FROM location_passwords WHERE location = ?').get(location);
    if (existing) {
      this.sqlite.prepare('UPDATE location_passwords SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE location = ?')
        .run(cleanPassword, location);
    } else {
      this.sqlite.prepare('INSERT INTO location_passwords (location, password) VALUES (?, ?)')
        .run(location, cleanPassword);
    }
  }
  
  getAllPasswords() {
    return this.sqlite.prepare('SELECT * FROM location_passwords').all();
  }
  
  // Подсказки
  getHint(location, hintLevel) {
    return this.sqlite.prepare(`
      SELECT * FROM hints 
      WHERE location = ? AND hint_level <= ?
      ORDER BY hint_level DESC
      LIMIT 1
    `).get(location, hintLevel);
  }
  
  createHint(hintData) {
    this.sqlite.prepare('DELETE FROM hints WHERE location = ? AND hint_level = ?')
      .run(hintData.location, hintData.hintLevel);
    
    this.sqlite.prepare(`
      INSERT INTO hints (location, hint_level, text)
      VALUES (?, ?, ?)
    `).run(hintData.location, hintData.hintLevel, hintData.text.trim());
  }
  
  getHintsForLocation(location) {
    return this.sqlite.prepare('SELECT * FROM hints WHERE location = ? ORDER BY hint_level').all(location);
  }
  
  // События
  logEvent(eventType, userId = null, location = null, eventData = {}) {
    this.sqlite.prepare(`
      INSERT INTO events (type, user_id, location, data)
      VALUES (?, ?, ?, ?)
    `).run(eventType, userId, location, JSON.stringify(eventData));
  }
  
  getAdminStats() {
    const totalPlayers = this.sqlite.prepare('SELECT COUNT(*) as count FROM players').get().count;
    const completedPlayers = this.sqlite.prepare(`
      SELECT COUNT(*) as count 
      FROM players 
      WHERE json_array_length(completed_locations) >= 6
    `).get().count;
    
    const recentEvents = this.sqlite.prepare(`
      SELECT * FROM events 
      ORDER BY created_at DESC 
      LIMIT 10
    `).all();
    
    return { totalPlayers, completedPlayers, recentEvents };
  }
}
