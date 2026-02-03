// app.js - упрощённая версия: 1 игрок = 1 команда
class QuestApp {
  constructor() {
    this.currentLocation = null;
    this.teamInfo = null;
    this.route = null;
    this.init();
  }

  async init() {
    console.log('🚀 Инициализация квеста (упрощённая регистрация)...');
    
    await new Promise(resolve => {
      if (window.tgApp?.isInited) {
        resolve();
      } else {
        document.addEventListener('telegramReady', resolve, { once: true });
      }
    });
    
    console.log('✅ Telegram готов');
    await this.loadQuestState();
  }

  async loadQuestState() {
    try {
      document.getElementById('loading').style.display = 'block';
      document.getElementById('errorMessage').style.display = 'none';
      
      await this.loadCurrentMission();
      
      document.getElementById('loading').style.display = 'none';
      document.getElementById('locationContent').style.display = 'block';
      
    } catch (error) {
      console.error('❌ Ошибка загрузки состояния квеста:', error);
      this.showError('Не удалось загрузить квест. Попробуйте обновить страницу.');
      document.getElementById('loading').style.display = 'none';
    }
  }

  async loadCurrentMission() {
    try {
      const response = await fetch('/get-mission', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': tgApp.userData.initData
        },
        body: JSON.stringify({})
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Ошибка загрузки задания');
      }
      
      const data = await response.json();
      
      // Обновляем информацию о команде
      if (data.team) {
        document.getElementById('teamInfo').style.display = 'block';
        document.getElementById('teamName').textContent = data.team.name || 'Моя команда';
        
        const completed = data.team.completedLocations || 0;
        document.getElementById('progress').textContent = `${completed}/6`;
        
        const hintsLeft = data.team.hintsLeft || 0;
        document.getElementById('hints').textContent = `${hintsLeft}/3`;
        
        this.route = data.team.route;
        this.currentLocation = data.location;
        
        // Отображаем маршрут
        this.displayRouteProgress();
        
        console.log(`📊 Прогресс: ${completed}/6, маршрут: ${this.route.join(' → ')}`);
      }
      
      await this.displayMission(data);
      
    } catch (error) {
      console.error('❌ Ошибка загрузки задания:', error);
      throw error;
    }
  }

  displayRouteProgress() {
    if (!this.route) return;
    
    const container = document.getElementById('routeProgress');
    if (!container) return;
    
    container.innerHTML = this.route.map((locId, index) => {
      const loc = window.locationGraph[locId];
      const isCurrent = locId === this.currentLocation;
      const isCompleted = index < this.route.indexOf(this.currentLocation);
      const statusClass = isCompleted ? 'completed' : (isCurrent ? 'current' : '');
      
      return `<span class="route-node ${statusClass}" title="${loc.name}">${loc.emoji}</span>`;
    }).join(' <span class="route-arrow">→</span> ');
  }

  async displayMission(data) {
    const loc = {
      name: data.locationName,
      emoji: data.locationEmoji,
      id: data.location
    };
    
    const order = this.route ? this.route.indexOf(data.location) + 1 : '?';
    
    const content = `
      <div class="location-header">
        <h2>${loc.emoji} ${loc.name}</h2>
        <p class="location-desc">Локация ${order} из 6</p>
      </div>
      
      <div class="password-section">
        <h3>Введите пароль доступа:</h3>
        <input type="text" id="passwordInput" placeholder="Пароль..." autocomplete="off">
        <button id="checkPasswordBtn" class="btn-primary">Проверить</button>
        <div id="passwordResult" class="result"></div>
      </div>
      
      <div class="mission-section" id="missionSection" style="display:none;">
        <h3>Задание:</h3>
        <div class="mission-text">${data.mission.text}</div>
        
        ${data.mission.imageUrl ? `<img src="${data.mission.imageUrl}" alt="Изображение задания" class="mission-image">` : ''}
        
        <div class="answer-section">
          <h4>Ваш ответ:</h4>
          <input type="text" id="answerInput" placeholder="Введите ответ...">
          <button id="checkAnswerBtn" class="btn-primary">Отправить ответ</button>
          <div id="answerResult" class="result"></div>
        </div>
        
        <div class="hint-section">
          <button id="requestHintBtn" class="btn-secondary">💡 Запросить подсказку</button>
          <div id="hintText" class="hint-text"></div>
        </div>
      </div>
      
      <div class="navigation" id="navSection" style="display:none;">
        <button id="nextLocationBtn" class="btn-primary">➡️ Следующая локация</button>
      </div>
    `;
    
    document.getElementById('locationContent').innerHTML = content;
    this.setupLocationHandlers(data.location);
  }

  setupLocationHandlers(locationId) {
    document.getElementById('checkPasswordBtn')?.addEventListener('click', async () => {
      const password = document.getElementById('passwordInput').value.trim();
      if (!password) {
        this.showResult('passwordResult', 'Введите пароль!', 'error');
        return;
      }
      
      const response = await fetch('/check-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': tgApp.userData.initData
        },
        body: JSON.stringify({ password })
      });
      
      const result = await response.json();
      const resultEl = document.getElementById('passwordResult');
      
      if (result.success) {
        this.showResult('passwordResult', result.message, 'success');
        document.getElementById('passwordInput').disabled = true;
        document.getElementById('checkPasswordBtn').disabled = true;
        document.getElementById('missionSection').style.display = 'block';
        
        if (result.location) {
          this.currentLocation = result.location;
          this.displayRouteProgress();
        }
      } else {
        this.showResult('passwordResult', result.message, 'error');
      }
    });
    
    document.getElementById('checkAnswerBtn')?.addEventListener('click', async () => {
      const answer = document.getElementById('answerInput').value.trim();
      if (!answer) {
        this.showResult('answerResult', 'Введите ответ!', 'error');
        return;
      }
      
      const response = await fetch('/check-answer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': tgApp.userData.initData
        },
        body: JSON.stringify({ answer })
      });
      
      const result = await response.json();
      const resultEl = document.getElementById('answerResult');
      
      if (result.success) {
        this.showResult('answerResult', result.message, 'success');
        document.getElementById('answerInput').disabled = true;
        document.getElementById('checkAnswerBtn').disabled = true;
        
        if (result.questComplete) {
          document.getElementById('locationContent').innerHTML = `
            <h2>🏆 КВЕСТ ЗАВЕРШЕН!</h2>
            <p class="congrats">Поздравляем! Вы спасли Кибердеревню от вируса "Тень Сети"!</p>
            <p>Ваш маршрут: ${this.route.map(id => window.locationGraph[id].emoji).join(' → ')}</p>
            <button onclick="window.location.reload()" class="btn-primary">Начать заново</button>
          `;
        } else {
          document.getElementById('navSection').style.display = 'block';
          
          if (result.nextLocation) {
            this.currentLocation = result.nextLocation;
            this.displayRouteProgress();
          }
        }
      } else {
        this.showResult('answerResult', result.message, 'error');
      }
    });
    
    document.getElementById('requestHintBtn')?.addEventListener('click', async () => {
      const response = await fetch('/request-hint', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': tgApp.userData.initData
        },
        body: JSON.stringify({ hintLevel: 1 })
      });
      
      const result = await response.json();
      if (result.success && result.text) {
        document.getElementById('hintText').textContent = `💡 ${result.text}`;
        document.getElementById('hintText').style.display = 'block';
        
        if (result.hintsLeft !== undefined) {
          document.getElementById('hints').textContent = `${result.hintsLeft}/3`;
        }
      } else {
        tgApp.showAlert(result.message || 'Не удалось получить подсказку');
      }
    });
    
    document.getElementById('nextLocationBtn')?.addEventListener('click', () => {
      this.loadCurrentMission();
    });
  }

  showResult(elementId, message, type) {
    const el = document.getElementById(elementId);
    el.textContent = message;
    el.className = `result ${type}`;
    el.style.display = 'block';
  }

  showError(message) {
    const el = document.getElementById('errorMessage');
    el.textContent = message;
    el.style.display = 'block';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.questApp = new QuestApp();
});

const style = document.createElement('style');
style.textContent = `
  .route-progress {
    display: flex;
    justify-content: center;
    align-items: center;
    margin: 15px 0;
    font-size: 1.5rem;
    gap: 8px;
    padding: 10px;
    background: rgba(106, 17, 203, 0.15);
    border-radius: 10px;
  }
  .route-arrow {
    color: #6a11cb;
    font-size: 1.2rem;
    margin: 0 4px;
  }
  .route-node {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    transition: all 0.3s;
  }
  .route-node.completed {
    background: rgba(40, 167, 69, 0.3);
    transform: scale(1.1);
  }
  .route-node.current {
    background: rgba(255, 193, 7, 0.3);
    box-shadow: 0 0 15px rgba(255, 193, 7, 0.5);
    transform: scale(1.2);
  }
  .location-desc {
    color: #888;
    font-size: 0.95rem;
    margin-top: 5px;
    font-weight: normal;
  }
  .subtitle { font-size: 1.1rem; color: #a0a0c0; margin: 15px 0 30px; line-height: 1.5; }
  .location-header h2 { font-size: 1.8rem; margin-bottom: 10px; }
  .password-section, .mission-section, .navigation { margin: 25px 0; text-align: left; }
  .mission-text { background: rgba(0,0,0,0.2); padding: 15px; border-radius: 10px; margin: 15px 0; line-height: 1.6; }
  .mission-image { max-width: 100%; border-radius: 10px; margin: 15px 0; display: block; }
  input { width: 100%; padding: 12px; margin: 8px 0; border: 1px solid #444; border-radius: 8px; background: rgba(0,0,0,0.2); color: white; font-size: 1rem; }
  .btn-primary { 
    background: linear-gradient(45deg, #6a11cb, #2575fc); 
    color: white; 
    border: none; 
    padding: 12px 30px; 
    font-size: 1rem; 
    border-radius: 50px; 
    cursor: pointer; 
    margin: 10px 0; 
    width: 100%; 
    transition: all 0.3s; 
  }
  .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 4px 15px rgba(106, 17, 203, 0.4); }
  .btn-primary:disabled { background: #6c757d; cursor: not-allowed; transform: none; }
  .btn-secondary { 
    background: rgba(106, 17, 203, 0.2); 
    color: #6a11cb; 
    border: 1px solid #6a11cb; 
    padding: 10px 20px; 
    border-radius: 50px; 
    cursor: pointer; 
    margin: 10px 0; 
    width: 100%; 
  }
  .result { padding: 10px; border-radius: 8px; margin: 10px 0; display: none; }
  .result.success { background: rgba(40, 167, 69, 0.2); border: 1px solid #28a745; color: #aaffaa; }
  .result.error { background: rgba(220, 53, 69, 0.2); border: 1px solid #dc3545; color: #ffaaaa; }
  .hint-text { background: rgba(255, 193, 7, 0.15); border-left: 3px solid #ffc107; padding: 10px; margin: 10px 0; display: none; }
  .congrats { font-size: 1.3rem; color: #4dff4d; margin: 20px 0; text-align: center; }
`;
document.head.appendChild(style);

// Граф локаций для фронтенда
window.locationGraph = {
  gates: { name: 'Врата Кибердеревни', emoji: '🚪' },
  dome: { name: 'Купол Защиты', emoji: '🛡️' },
  mirror: { name: 'Зеркало Истины', emoji: '🪞' },
  stone: { name: 'Камень Пророчеств', emoji: '🔮' },
  hut: { name: 'Хижина Хранителя', emoji: '🏠' },
  lair: { name: 'Логово Вируса', emoji: '👾' }
};
