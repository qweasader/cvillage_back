// database.js — полноценная БД в одном файле

import Database from 'better-sqlite3';
import { CONFIG } from './config.js';

const db = new Database('database.sqlite', { verbose: false });

// Инициализация таблиц при первом запуске
function initializeDatabase() {
  // Игроки
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT NOT NULL,
      last_name TEXT,
      team_id TEXT,
      hints_used INTEGER DEFAULT 0 CHECK (hints_used <= ${CONFIG.MAX_HINTS}),
      completed_locations TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Задания
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      location TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      answer TEXT NOT NULL,
      image_url TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Пароли локаций
  db.exec(`
    CREATE TABLE IF NOT EXISTS location_passwords (
      location TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Подсказки
  db.exec(`
    CREATE TABLE IF NOT EXISTS hints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location TEXT NOT NULL,
      hint_level INTEGER NOT NULL CHECK (hint_level BETWEEN 1 AND 3),
      text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(location, hint_level)
    )
  `);
  
  // События (аудит)
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      user_id INTEGER,
      location TEXT,
      data TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Индексы для производительности
  db.exec('CREATE INDEX IF NOT EXISTS idx_players_id ON players(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)');
  
  console.log('✅ Database initialized');
}

// Методы работы с БД
export class Database {
  constructor() {
    initializeDatabase();
  }
  
  // Игроки
  getPlayer(userId) {
    return db.prepare('SELECT * FROM players WHERE id = ?').get(userId);
  }
  
  createOrUpdatePlayer(userId, data) {
    const existing = this.getPlayer(userId);
    
    if (existing) {
      const stmt = db.prepare(`
        UPDATE players 
        SET username = ?, first_name = ?, last_name = ?, team_id = ?, last_activity = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      stmt.run(
        data.username || null,
        data.first_name || '',
        data.last_name || null,
        data.team_id || null,
        userId
      );
    } else {
      const stmt = db.prepare(`
        INSERT INTO players (id, username, first_name, last_name, team_id)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(
        userId,
        data.username || null,
        data.first_name || '',
        data.last_name || null,
        data.team_id || null
      );
    }
    
    return this.getPlayer(userId);
  }
  
  useHint(userId) {
    const player = this.getPlayer(userId);
    if (!player) throw new Error('Player not found');
    if (player.hints_used >= CONFIG.MAX_HINTS) return false;
    
    const stmt = db.prepare('UPDATE players SET hints_used = hints_used + 1 WHERE id = ?');
    stmt.run(userId);
    return true;
  }
  
  completeLocation(userId, locationId) {
    const player = this.getPlayer(userId);
    if (!player) throw new Error('Player not found');
    
    let completed = JSON.parse(player.completed_locations || '[]');
    if (!completed.includes(locationId)) {
      completed.push(locationId);
      
      const stmt = db.prepare('UPDATE players SET completed_locations = ? WHERE id = ?');
      stmt.run(JSON.stringify(completed), userId);
    }
  }
  
  // Задания
  getMission(location) {
    return db.prepare('SELECT * FROM missions WHERE location = ?').get(location);
  }
  
  setMission(location, missionData) {
    const existing = this.getMission(location);
    
    if (existing) {
      const stmt = db.prepare(`
        UPDATE missions 
        SET text = ?, answer = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE location = ?
      `);
      stmt.run(missionData.text, missionData.answer, missionData.imageUrl || null, location);
    } else {
      const stmt = db.prepare(`
        INSERT INTO missions (location, text, answer, image_url)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(location, missionData.text, missionData.answer, missionData.imageUrl || null);
    }
    
    return this.getMission(location);
  }
  
  getAllMissions() {
    return db.prepare('SELECT * FROM missions ORDER BY location').all();
  }
  
  // Пароли
  getPassword(location) {
    const row = db.prepare('SELECT password FROM location_passwords WHERE location = ?').get(location);
    return row ? row.password : null;
  }
  
  setPassword(location, password) {
    const existing = db.prepare('SELECT 1 FROM location_passwords WHERE location = ?').get(location);
    
    if (existing) {
      const stmt = db.prepare('UPDATE location_passwords SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE location = ?');
      stmt.run(password, location);
    } else {
      const stmt = db.prepare('INSERT INTO location_passwords (location, password) VALUES (?, ?)');
      stmt.run(location, password);
    }
  }
  
  getAllPasswords() {
    return db.prepare('SELECT * FROM location_passwords').all();
  }
  
  // Подсказки
  getHint(location, hintLevel) {
    return db.prepare(`
      SELECT * FROM hints 
      WHERE location = ? AND hint_level <= ?
      ORDER BY hint_level DESC
      LIMIT 1
    `).get(location, hintLevel);
  }
  
  createHint(hintData) {
    // Удаляем существующую подсказку того же уровня
    db.prepare('DELETE FROM hints WHERE location = ? AND hint_level = ?')
      .run(hintData.location, hintData.hintLevel);
    
    const stmt = db.prepare(`
      INSERT INTO hints (location, hint_level, text)
      VALUES (?, ?, ?)
    `);
    stmt.run(hintData.location, hintData.hintLevel, hintData.text);
    
    return this.getHint(hintData.location, hintData.hintLevel);
  }
  
  getHintsForLocation(location) {
    return db.prepare('SELECT * FROM hints WHERE location = ? ORDER BY hint_level').all(location);
  }
  
  // События
  logEvent(eventType, userId = null, location = null, eventData = {}) {
    const stmt = db.prepare(`
      INSERT INTO events (type, user_id, location, data)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(eventType, userId, location, JSON.stringify(eventData));
  }
  
  // Статистика
  getAdminStats() {
    const totalPlayers = db.prepare('SELECT COUNT(*) as count FROM players').get().count;
    const completedPlayers = db.prepare(`
      SELECT COUNT(*) as count 
      FROM players 
      WHERE json_array_length(completed_locations) >= 6
    `).get().count;
    
    const recentEvents = db.prepare(`
      SELECT * FROM events 
      ORDER BY created_at DESC 
      LIMIT 10
    `).all();
    
    return { totalPlayers, completedPlayers, recentEvents };
  }
}
