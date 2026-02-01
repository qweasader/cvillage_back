// database.js — поддержка командного квеста
import sqlite3 from 'better-sqlite3';

export class QuestDatabase {
  constructor() {
    this.db = sqlite3('quest.db');
    this.initDatabase();
  }

  initDatabase() {
    // Команды (новая таблица)
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

    // Игроки (обновлённая структура)
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

    // Пароли доступа
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
  }

  // ============ КОМАНДЫ ============
  getTeamByCode(code) {
    return this.db.prepare('SELECT * FROM teams WHERE code = ?').get(code.toUpperCase().trim());
  }

  getTeamById(teamId) {
    return this.db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  }

  createTeam(code, name) {
    // Генерируем уникальный код, если не задан
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
    // Проверяем уникальность
    if (this.getTeamByCode(code)) {
      return this.generateTeamCode();
    }
    return code;
  }

  // ============ ИГРОКИ ============
  getPlayer(userId) {
    return this.db.prepare('SELECT * FROM players WHERE id = ?').get(String(userId));
  }

  // Регистрация игрока в команде
  registerPlayer(userId, teamCode, playerName = null) {
    // Получаем или создаём команду
    let team = this.getTeamByCode(teamCode);
    if (!team) {
      team = this.createTeam(teamCode, `Команда ${teamCode}`);
    }
    
    // Обновляем или создаём игрока
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

  // Проверка регистрации
  isPlayerRegistered(userId) {
    const player = this.getPlayer(userId);
    return player && player.is_registered;
  }

  // Завершение локации (на уровне команды)
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
      
      // Разблокируем следующую локацию
      this.unlockNextLocationForTeam(teamId);
    }
  }

  // Разблокировка следующей локации
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

  // Использование подсказки (на уровне команды)
  useHintForTeam(teamId) {
    const team = this.getTeamById(teamId);
    if (!team || team.hints_used >= 3) return false;
    
    this.db.prepare('UPDATE teams SET hints_used = hints_used + 1, last_activity = CURRENT_TIMESTAMP WHERE id = ?')
      .run(teamId);
    return true;
  }

  // Получение состава команды
  getTeamMembers(teamId) {
    return this.db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY registered_at').all(teamId);
  }

  // ============ ПАРОЛИ, ЗАДАНИЯ, ПОДСКАЗКИ ============
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
