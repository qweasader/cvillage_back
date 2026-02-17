// telegram.js - полная версия с правильной обработкой инициализации
class TelegramMiniApp {
    constructor() {
        this.isTelegram = false;
        this.userData = null;
        this.isInited = false;
        this.tg = null;
        this.backendUrl = null;
        this.loadConfig();
        if (window.Telegram?.WebApp) {
            this.init();
        } else {
            this.loadTelegramSDK().then(() => this.init());
        }
    }

    loadConfig() {
        if (window?.env?.BACKEND_URL) {
            this.backendUrl = window.env.BACKEND_URL;
            return;
        }

        const metaTag = document.querySelector('meta[name="backend-url"]');
        if (metaTag) {
            this.backendUrl = metaTag.content;
            return;
        }

        const configElement = document.getElementById('app-config');
        if (configElement) {
            try {
                const config = JSON.parse(configElement.textContent);
                this.backendUrl = config.backendUrl;
                return;
            } catch (e) {
                console.warn('⚠️ Failed to parse config element');
            }
        }

        console.warn('⚠️ Backend URL not configured');
    }

    loadTelegramSDK() {
        return new Promise((resolve) => {
            if (window.Telegram?.WebApp) {
                resolve();
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://telegram.org/js/telegram-web-app.js';
            script.async = true;
            script.onload = () => {
                console.log('✅ Telegram Web Apps SDK загружен');
                resolve();
            };
            script.onerror = (e) => {
                console.error('❌ Не удалось загрузить Telegram SDK:', e);
                resolve();
            };
            document.head.appendChild(script);
        });
    }

    async init() {
        try {
            await new Promise(resolve => setTimeout(resolve, 100));
            
            if (window.Telegram?.WebApp) {
                this.isTelegram = true;
                this.tg = window.Telegram.WebApp;
                this.tg.ready();

                const initDataUnsafe = this.tg.initDataUnsafe || {};
                this.userData = {
                    id: initDataUnsafe?.user?.id,
                    firstName: initDataUnsafe?.user?.first_name,
                    lastName: initDataUnsafe?.user?.last_name,
                    username: initDataUnsafe?.user?.username,
                    teamId: this.getTeamIdFromParams(),
                    isPremium: initDataUnsafe?.user?.is_premium || false,
                    initData: this.tg.initData
                };

                if (!this.userData.initData || this.userData.initData.trim() === '') {
                    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: initData ПУСТОЙ!');
                    console.error('Проверьте:');
                    console.error('1. Домен добавлен в @BotFather через /setdomain?');
                    console.error('2. Приложение открыто через кнопку в боте?');
                    console.error('3. URL начинается с https://?');
                    
                    setTimeout(() => {
                        this.showAlert(
                            '❌ КРИТИЧЕСКАЯ ОШИБКА АВТОРИЗАЦИИ!\n\n' +
                            'Причина: Telegram не передал данные авторизации.\n\n' +
                            'РЕШЕНИЕ:\n' +
                            '1. Закройте это окно\n' +
                            '2. Напишите боту /start\n' +
                            '3. Нажмите кнопку "Начать квест"\n\n' +
                            'Если ошибка повторяется:\n' +
                            '• Проверьте, что домен добавлен в @BotFather (/setdomain)\n' +
                            '• Убедитесь, что используется HTTPS'
                        );
                    }, 500);
                } else {
                    console.log('✅ Telegram Mini App инициализирован');
                    console.log('👤 User ID:', this.userData.id);
                    console.log('🔑 InitData длина:', this.userData.initData.length);
                }

                this.setupCloseButton();
                this.setupMainButton();
                this.isInited = true;
                this.onReady();
            } else {
                console.log('🌐 Не запущено в Telegram Mini App');
                this.loadMockData();
                this.isInited = true;
                this.onReady();
            }
        } catch (error) {
            console.error('❌ Ошибка инициализации Telegram:', error);
            this.loadMockData();
            this.isInited = true;
            this.onReady();
        }
    }

    loadMockData() {
        this.userData = {
            id: `web_${Date.now()}`,
            firstName: 'Тест',
            lastName: 'Пользователь',
            username: 'test_user',
            teamId: this.getTeamIdFromParams() || `team_${Math.floor(Math.random() * 1000)}`,
            isWebVersion: true,
            initData: ''
        };
        console.log('🔧 Загружены тестовые данные:', this.userData);
    }

    getTeamIdFromParams() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('team') || null;
    }

    onReady() {
        document.dispatchEvent(new CustomEvent('telegramReady', {
            detail: {
                isTelegram: this.isTelegram,
                userData: this.userData,
                isWebVersion: !this.isTelegram
            }
        }));
    }

    setupCloseButton() {
        if (this.isTelegram && !document.querySelector('.close-button')) {
            const closeButton = document.createElement('button');
            closeButton.className = 'close-button telegram-close';
            closeButton.innerHTML = '✕';
            closeButton.onclick = () => this.closeApp();
            document.body.appendChild(closeButton);
        }
    }

    setupMainButton() {
        if (this.isTelegram && this.tg.MainButton) {
            this.tg.MainButton.textColor = '#ffffff';
            this.tg.MainButton.color = '#6a11cb';
        }
    }

    closeApp() {
        if (this.isTelegram) {
            this.tg.close();
        } else {
            window.history.back();
        }
    }

    showAlert(message, callback) {
        if (this.isTelegram && this.tg) {
            this.tg.showAlert(message, callback);
        } else {
            alert(message);
            if (callback) setTimeout(callback, 100);
        }
    }

    showConfirm(message, callback) {
        if (this.isTelegram && this.tg) {
            this.tg.showConfirm(message, callback);
        } else {
            const result = confirm(message);
            if (callback) callback(result);
        }
    }

    async getMission(location) {
        if (!this.backendUrl) {
            console.warn('⚠️ Backend URL not configured');
            return null;
        }

        if (!this.userData?.initData) {
            console.error('❌ initData is missing! App must be opened via Telegram');
            this.showAlert('Ошибка авторизации. Откройте приложение через Telegram!');
            return null;
        }

        try {
            const response = await fetch(`${this.backendUrl}/get-mission`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Telegram-Init-Data': this.userData.initData
                },
                body: JSON.stringify({
                    location,
                    userId: this.userData.id,
                    teamId: this.userData.teamId
                })
            });

            if (!response.ok) {
                const error = await response.json();
                console.error('❌ Mission fetch failed:', error);
                if (error.requiresRegistration) {
                    this.showAlert('Сначала зарегистрируйтесь в боте! Напишите /start');
                }
                return null;
            }

            const result = await response.json();
            return result.mission;
        } catch (error) {
            console.error('❌ Failed to get mission:', error);
            return null;
        }
    }

    async sendGameEvent(eventType, eventData = {}) {
        if (!this.userData?.initData && !this.isTelegram) {
            console.warn('⚠️ Not in Telegram, skipping event send');
            return false;
        }

        if (!this.backendUrl) {
            console.warn('⚠️ Backend URL not configured');
            return false;
        }

        if (!this.userData?.initData) {
            console.error('❌ initData is missing!');
            return false;
        }

        try {
            const response = await fetch(`${this.backendUrl}/game-event`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Telegram-Init-Data': this.userData.initData
                },
                body: JSON.stringify({
                    eventType,
                    eventData,
                    userId: this.userData.id,
                    teamId: this.userData.teamId,
                    timestamp: new Date().toISOString()
                })
            });

            if (!response.ok) {
                console.error('❌ Event send failed:', response.status);
                return false;
            }

            const result = await response.json();
            console.log('✅ Event sent:', eventType, result);
            return result;
        } catch (error) {
            console.error('❌ Failed to send event:', error);
            return false;
        }
    }

    async requestHint(location, hintLevel = 1) {
        if (!this.userData?.initData) {
            this.showAlert('⚠️ Подсказки доступны только в Telegram Mini App');
            return null;
        }

        if (!this.backendUrl) {
            this.showAlert('⚠️ Сервис временно недоступен');
            return null;
        }

        try {
            const response = await fetch(`${this.backendUrl}/request-hint`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Telegram-Init-Data': this.userData.initData
                },
                body: JSON.stringify({
                    location,
                    hintLevel,
                    userId: this.userData.id,
                    teamId: this.userData.teamId
                })
            });

            if (!response.ok) {
                const error = await response.json();
                if (error.error === 'no_hints_left') {
                    this.showAlert('🚫 Подсказки закончились!');
                } else if (error.error === 'not_found') {
                    this.showAlert('🤔 Подсказка не найдена.');
                } else {
                    this.showAlert('❌ Ошибка при запросе подсказки');
                }
                return null;
            }

            const result = await response.json();
            return result;
        } catch (error) {
            console.error('❌ Failed to request hint:', error);
            this.showAlert('❌ Ошибка при запросе подсказки');
            return null;
        }
    }

    async checkLocationPassword(location, password) {
        if (!this.backendUrl) {
            console.warn('⚠️ Backend URL не настроен');
            return { success: false, message: 'Сервис недоступен' };
        }

        if (!this.userData?.initData) {
            console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: initData отсутствует!');
            console.error('Проверьте, что приложение запущено через Telegram Web Apps');
            console.error('userData:', this.userData);
            
            this.showAlert(
                'Ошибка авторизации!\n\n' +
                'Приложение должно быть запущено ТОЛЬКО через кнопку "Начать квест" в боте.\n\n' +
                'Закройте это окно и нажмите кнопку в боте ещё раз.'
            );
            
            return { 
                success: false, 
                message: 'Не авторизован. Откройте приложение через кнопку в боте!' 
            };
        }

        if (!this.userData?.id) {
            console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: userId отсутствует в initData!');
            this.showAlert('Ошибка: не удалось определить вашу учётную запись. Перезапустите приложение через бота.');
            return { success: false, message: 'Ошибка авторизации' };
        }

        try {
            console.log(`📤 Отправка запроса на /check-password`);
            console.log(`   Location: ${location}`);
            console.log(`   UserId: ${this.userData.id}`);
            console.log(`   TeamId: ${this.userData.teamId}`);
            console.log(`   InitData длина: ${this.userData.initData.length}`);

            const response = await fetch(`${this.backendUrl}/check-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Telegram-Init-Data': this.userData.initData
                },
                body: JSON.stringify({
                    location,
                    password,
                    userId: this.userData.id,
                    teamId: this.userData.teamId
                })
            });

            const result = await response.json();
            console.log(`📥 Получен ответ от /check-password:`, result);

            if (!response.ok) {
                console.warn(`⚠️ Ошибка ${response.status}:`, result.message);
                
                if (result.requiresRegistration) {
                    this.showAlert(
                        '❗️ Вы не зарегистрированы в квесте!\n\n' +
                        '1. Закройте это окно\n' +
                        '2. Напишите боту /start\n' +
                        '3. Введите код команды\n' +
                        '4. Нажмите "Начать квест" снова'
                    );
                } else if (response.status === 401) {
                    this.showAlert(
                        '🔐 Ошибка авторизации!\n\n' +
                        'Приложение должно быть запущено ТОЛЬКО через кнопку "Начать квест" в боте.\n\n' +
                        'Закройте это окно и нажмите кнопку в боте ещё раз.'
                    );
                }
                
                return result;
            }

            return result;
        } catch (error) {
            console.error('❌ Критическая ошибка при проверке пароля:', error);
            this.showAlert(
                'Произошла ошибка при подключении к серверу.\n\n' +
                'Проверьте интернет-соединение и попробуйте ещё раз.\n\n' +
                'Если ошибка повторяется, напишите организаторам.'
            );
            return { success: false, message: 'Ошибка подключения' };
        }
    }

    saveProgress(key, value) {
        localStorage.setItem(`quest_${key}`, value);
    }

    getProgress(key) {
        return localStorage.getItem(`quest_${key}`);
    }

    getAllLocations() {
        return [
           { id: 'gates', name: 'Врата Кибердеревни', emoji: '🚪', order: 1 },
            { id: 'dome', name: 'Односторонний Портал', emoji: '🌀', order: 2 },
            { id: 'mirror', name: 'Призрачный Мост', emoji: '👻', order: 3 },
            { id: 'stone', name: 'Логово Паука', emoji: '🕸️', order: 4 },
            { id: 'hut', name: 'Белый Кролик', emoji: '🐇', order: 5 },
            { id: 'lair', name: 'Купол Пророчеств', emoji: '🔮', order: 6 }
        ];
    }

    getLocationName(locationId) {
        const location = this.getAllLocations().find(l => l.id === locationId);
        return location ? location.name : locationId;
    }
}

const tgApp = window.tgApp || new TelegramMiniApp();
window.tgApp = tgApp;

console.log('🚀 TelegramMiniApp инициализация запущена');
