'use strict';

var obsidian = require('obsidian');

class YandexCalendarIntegrationPlugin extends obsidian.Plugin {
    settings = null;
    secureSettings = null;

    async onload() {
        console.log('Yandex Calendar plugin is starting...');
        this.initializePlugin();
    }

    async initializePlugin() {
        try {
            this.secureSettings = new SecureSettings(this);
            await this.loadSettings();
            this.addSettingTab(new YandexCalendarIntegrationSettingTab(this.app, this));
            this.registerCommands();
        } catch (error) {
            console.error('Failed to initialize plugin:', error);
            new Notice('Failed to initialize Yandex Calendar plugin');
        }
    }

    registerCommands() {
        this.addCommand({
            id: 'insert-event-from-yandex-calendar-at-cursor',
            name: 'Вставить событие из Яндекс Календаря в позицию курсора',
            editorCallback: (editor) => {
                this.insertEvent(editor);
            }
        });
    }

    async makeRequest(email, password, baseUrl, uri, body) {
        try {
            const token = btoa(`${email}:${password}`);
            const url = baseUrl + uri;

            const response = await requestUrl({
                url: url,
                method: 'REPORT',
                headers: {
                    'Authorization': `Basic ${token}`,
                    'Content-Type': 'application/xml',
                    'Depth': '1'
                },
                body: body
            });

            new Notice('Яндекс Календарь успешно вернул события');
            return response.text;
        } catch (error) {
            console.error('Запрос к Яндекс Календарю завершился ошибкой: ', error);
            new Notice('Запрос к Яндекс Календарю завершился ошибкой: ' + error.message);
            throw error;
        }
    }

    parseCalendarEvents(xmlText) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        const responses = xmlDoc.getElementsByTagNameNS('DAV:', 'response');
        
        return Array.from(responses).map(response => {
            try {
                const calendarData = response.getElementsByTagNameNS('urn:ietf:params:xml:ns:caldav', 'calendar-data')[0];
                if (!calendarData) return null;

                const icalText = calendarData.textContent;
                const veventMatch = icalText.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/);

                return veventMatch ? this.parseYandexCalendar(veventMatch) : null;
            } catch (error) {
                console.error('Error parsing event:', error);
                return null;
            }
        }).filter(event => event !== null);
    }

    parseYandexCalendar(data) {
        const lines = String(data).split('\n');
        const eventData = {};

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (line.startsWith('SUMMARY:')) {
                eventData.summary = line.substring(8);
            } else if (line.startsWith('DTSTART;TZID=')) {
                const dateStr = line.substring(line.indexOf(':') + 1);
                eventData.dateStart = this.parseYandexCalendarDate(dateStr);
            } else if (line.startsWith('DTEND;TZID=')) {
                const dateStr = line.substring(line.indexOf(':') + 1);
                eventData.dateEnd = this.parseYandexCalendarDate(dateStr);
            } else if (line.startsWith('DESCRIPTION:')) {
                eventData.description = line.substring(12);
            } else if (line.startsWith('URL:')) {
                eventData.url = line.substring(4);
            }
        }

        return new CalendarEventDto(
            eventData.summary,
            eventData.dateStart,
            eventData.dateEnd,
            this.getTimeOnly(eventData.dateStart),
            this.getTimeOnly(eventData.dateEnd),
            eventData.description,
            eventData.url
        );
    }

    getTimeOnly(dateString) {
        if (!dateString) return '';
        
        const date = new Date(dateString);
        return date.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    parseYandexCalendarDate(dateStr) {
        const [year, month, day, hour, minute, second] = [
            dateStr.substring(0, 4),
            dateStr.substring(4, 6),
            dateStr.substring(6, 8),
            dateStr.substring(9, 11) || '00',
            dateStr.substring(11, 13) || '00',
            dateStr.substring(13, 15) || '00'
        ];

        return new Date(
            parseInt(year),
            parseInt(month) - 1,
            parseInt(day),
            parseInt(hour),
            parseInt(minute),
            parseInt(second)
        );
    }

    //Для настроек плагина
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
    }
    //Для настроек плагина
    async saveSettings() {
        await this.saveData(this.settings)
    }

    async insertEvent(editor) {
        try {
            if (!this.validateSecurityRequirements()) {
                return;
            }

            const events = await this.getEvents();
            const pattern = this.settings.pattern;

            const sortedEvents = events.sort((a, b) => a.dateStart.getTime() - b.dateStart.getTime());
            const formattedEvents = await this.formatEventsByPattern(sortedEvents, pattern);
           
            const cursor = editor.getCursor();
            editor.replaceRange(formattedEvents, cursor);
        } catch (error) {
            console.error('Failed to insert event:', error);
            new Notice('Failed to insert event from Yandex Calendar');
        }
    }

    validateSecurityRequirements() {
        if (!this.secureSettings.hasStoredPassword()) {
            new Notice('No password stored. Please save a password first.');
            return false;
        }
        return true;
    }

    async getStoredPassword() {
        return this.secureSettings.hasStoredPassword() 
            ? await this.secureSettings.getPassword() 
            : null;
    }

    async getEvents() {
        try {
            const email = this.settings.email;
            const password = await this.getStoredPassword();

            if (!email || !password) {
                new Notice('Email or password not configured');
                throw new Error('Email or password not configured');
            }

            const baseUrl = 'https://caldav.yandex.ru';
            const uri = `/calendars/${email}/events-default`;
            const currentDate = this.getCurrentDailyNoteDate();

            if (!currentDate) {
                return [];
            }

            const { start, end } = this.getDateRange(currentDate);
            const body = this.buildCalendarQuery(start, end);

            const data = await this.makeRequest(email, password, baseUrl, uri, body);
            const events = this.parseCalendarEvents(data);
            console.log('Parsed events: ', events);
            return events;
        } catch (error) {
            console.error('Failed to get events:', error);
            return [];
        }
    }

    buildCalendarQuery(start, end) {
        return `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
    <D:prop>
        <D:getetag/>
        <C:calendar-data>
            <C:comp name="VCALENDAR">
                <C:comp name="VEVENT">
                    <C:prop name="SUMMARY"/>
                    <C:prop name="DTSTART"/>
                    <C:prop name="DTEND"/>
                    <C:prop name="DESCRIPTION"/>
                    <C:prop name="URL"/>
                </C:comp>
                <C:comp name="VTIMEZONE"/></C:comp>
        </C:calendar-data>
    </D:prop>
    <C:filter>
        <C:comp-filter name="VCALENDAR">
            <C:comp-filter name="VEVENT">
                <C:time-range start="${start}" end="${end}"/>
            </C:comp-filter>
        </C:comp-filter>
    </C:filter>
</C:calendar-query>`;
    }

    getCurrentDailyNoteDate() {
        const activeFile = this.app.workspace.getActiveFile();
        const dailyNotes = this.getDailyNotesInstance();

        if (!dailyNotes) {
            new Notice('Плагин Daily Notes не найден');
            return null;
        }

        if (!activeFile) {
            new Notice('Нет активной заметки');
            return null;
        }

        const dateFormat = dailyNotes.getFormat();
        
        if (this.isDailyNote(dateFormat, activeFile.basename)) {
            const noteDate = this.parseDateFromString(dateFormat, activeFile.basename);
            new Notice(`Дата заметки: ${noteDate.toLocaleDateString('ru-RU')}`);
            return noteDate;
        } else {
            new Notice('Это не ежедневная заметка');
            return null;
        }
    }

    isDailyNote(template, str) {
        const regexPattern = this.createDateRegexPattern(template);
        return new RegExp(`^${regexPattern}$`).test(str);
    }

    createDateRegexPattern(template) {
        return template
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/YYYY/g, '(\\d{4})')
            .replace(/YY/g, '(\\d{2})')
            .replace(/MM/g, '(\\d{2})')
            .replace(/DD/g, '(\\d{2})');
    }

    parseDateFromString(template, str) {
        // Создаем regex паттерн с группами захвата
        const { regexPattern, componentOrder } = this.createRegexWithCaptureGroups(template);
        const regex = new RegExp(`^${regexPattern}$`);
        const match = str.match(regex);

        if (!match) {
            throw new Error('Не удалось извлечь дату');
        }

        // Извлекаем компоненты даты
        const components = {};
        for (let i = 0; i < componentOrder.length; i++) {
            components[componentOrder[i]] = parseInt(match[i + 1], 10);
        }

        // Собираем полную дату
        let year, month, day;

        // Обрабатываем год
        if (components.YYYY) {
            year = components.YYYY;
        } else if (components.YY) {
            year = 2000 + components.YY; // Преобразуем YY в YYYY
        } else {
            throw new Error('Не найден год в шаблоне');
        }

        // Обрабатываем месяц
        if (components.MM) {
            month = components.MM - 1; // Месяцы в JS: 0-11
        } else {
            throw new Error('Не найден месяц в шаблоне');
        }

        // Обрабатываем день
        if (components.DD) {
            day = components.DD;
        } else {
            throw new Error('Не найден день в шаблоне');
        }

        // Создаем и проверяем дату
        const date = new Date(year, month, day);

        if (isNaN(date.getTime())) {
            throw new Error('Некорректная дата');
        }

        // Проверяем, что компоненты соответствуют (на случай 31 февраля и т.д.)
        if (date.getFullYear() !== year ||
            date.getMonth() !== month ||
            date.getDate() !== day) {
            throw new Error('Некорректная дата');
        }

        return date;
    }

    createRegexWithCaptureGroups(template) {
        const componentOrder = [];

        const regexPattern = template
            // Экранируем специальные символы для regex
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            // Заменяем компоненты даты на соответствующие regex группы захвата
            .replace(/YYYY/g, () => {
                componentOrder.push('YYYY');
                return '(\\d{4})';
            })
            .replace(/YY/g, () => {
                componentOrder.push('YY');
                return '(\\d{2})';
            })
            .replace(/MM/g, () => {
                componentOrder.push('MM');
                return '(\\d{2})';
            })
            .replace(/DD/g, () => {
                componentOrder.push('DD');
                return '(\\d{2})';
            });

        return { regexPattern, componentOrder };
    }


    getDailyNotesInstance() {
        if (this.app.internalPlugins) {
            const plugin = this.app.internalPlugins.getPluginById('daily-notes');
            return plugin?.instance || null;
        }
        return null;
    }

    getDateRange(currentDate) {
        // Создаем даты начала и конца в локальном часовом поясе
        const start = new Date(
            currentDate.getFullYear(),
            currentDate.getMonth(),
            currentDate.getDate(),
            0, 0, 0, 0
        );

        const end = new Date(
            currentDate.getFullYear(),
            currentDate.getMonth(),
            currentDate.getDate() + 1,
            0, 0, 0, 0
        );

        // Форматируем в нужный строковый формат
        const formatDate = (date) => {
            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, '0');
            const day = String(date.getUTCDate()).padStart(2, '0');
            const hours = String(date.getUTCHours()).padStart(2, '0');
            const minutes = String(date.getUTCMinutes()).padStart(2, '0');
            const seconds = String(date.getUTCSeconds()).padStart(2, '0');

            return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
        };

        return {
            start: formatDate(start),
            end: formatDate(end)
        };
    }

    async formatEventsByPattern(events, pattern) {
        let patternFormattedEvents = '';
        for (let event of events) {
            let formatText = event.formatByPatternEvent(pattern);
            patternFormattedEvents = patternFormattedEvents + formatText + '\n';
        }
        return await this.unescapeTemplateLiterals(patternFormattedEvents);
    }

    async unescapeTemplateLiterals(text) {
        return text.replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\r/g, '\r');
    }
}

class CalendarEventDto {
    summary = '';
    dateStart = '';
    dateEnd = '';
    timeStart = '';
    timeEnd = '';
    description = '';
    url = '';

    constructor(summary, dateStart, dateEnd, timeStart, timeEnd, description, url) {
        this.summary = summary;
        this.dateStart = dateStart;
        this.dateEnd = dateEnd;
        this.timeStart = timeStart;
        this.timeEnd = timeEnd;
        this.description = description;
        this.url = url;
    }

    formatByPatternEvent(pattern) {
        return pattern.replace(/\${(.*?)}/g, (match, key) => {
            return this.hasOwnProperty(key) && this[key] ? this[key] : '';
        });
    }
}

class YandexCalendarIntegrationSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;

        containerEl.empty();

        this.renderEmailSetting(containerEl);
        this.renderPasswordInput(containerEl);
        this.renderPatternSetting(containerEl);
    }

    renderEmailSetting(containerEl) {
        new obsidian.Setting(containerEl)
            .setName('Email')
            .setDesc('Enter the email address that is used for scheduling in the calendar')
            .addText((text) => text
                .setPlaceholder('Enter your email')
                .setValue(this.plugin.settings.email)
                .onChange(async (value) => {
                    this.plugin.settings.email = value;
                    await this.plugin.saveSettings();
                })
            );
    }

    renderPasswordInput(containerEl) {
        const linkContainer = containerEl.createDiv();
        linkContainer.appendText("Enter your Yandex Calendar ");
        
        const linkElement = document.createElement('a');
        linkElement.href = 'https://id.yandex.ru/security/app-passwords';
        linkElement.textContent = 'app password';
        linkContainer.appendChild(linkElement);

        let password = '';

        // Сохранение пароля
        new obsidian.Setting(containerEl)
            .setName('Password')
            .setDesc(linkContainer)
            .addText(text => text
                .setPlaceholder('Enter password')
                .setValue('')
                .onChange((value) => password = value)
            )
            .addButton(button => button
                .setButtonText('Save Password')
                .setCta()
                .onClick(async () => {
                    if (!password) {
                        new Notice('Please enter a password');
                        return;
                    }

                    await this.plugin.secureSettings.savePassword(password);
                    new Notice('Password saved securely!');
                    this.display();
                })
            ).addButton(button => button
                .setButtonText('Clear Password')
                .onClick(async () => {
                    this.plugin.secureSettings.clearPassword();
                    new Notice('Password cleared');
                    this.display();
                })
            );
    }

    renderPatternSetting(containerEl) {
        new obsidian.Setting(containerEl)
            .setName('Event task pattern')
            .setDesc('Enter a pattern for the event task')
            .addText((text) => text
                .setPlaceholder('Enter pattern')
                .setValue(this.plugin.settings.pattern)
                .onChange(async (value) => {
                    this.plugin.settings.pattern = value;
                    await this.plugin.saveSettings();
                })
            );
    }
}

const DEFAULT_SETTINGS = {
    pattern: "- [ ] ${timeStart} - ${timeEnd}: ${summary}\n\tОписание: ${description}\n\tСсылка на событие: ${url}",
    email: ''
}

class SecureSettings {
    constructor(plugin) {
        this.plugin = plugin;
        this.serviceId = `yandex-calendar-${plugin.manifest.id}`;
    }

    async savePassword(password) {
        try {
            // Используем встроенный API Obsidian для безопасного хранения
            if (this.plugin.app.saveLocalStorage) {
                await this.plugin.app.saveLocalStorage(this.serviceId, password);
                return true;
            }
        } catch (error) {
            console.error('Failed to save password:', error);
        }
        return false;
    }

    async getPassword() {
        try {
            if (this.plugin.app.loadLocalStorage) {
                return await this.plugin.app.loadLocalStorage(this.serviceId);
            }
        } catch (error) {
            console.error('Failed to load password:', error);
        }
        return null;
    }

    async hasStoredPassword() {
        // Проверяем через асинхронный метод
        return this.getPassword().then(pwd => pwd !== null);
    }

     async clearPassword() {
        try {
            if (this.plugin.app.saveLocalStorage) {
                await this.plugin.app.saveLocalStorage(this.serviceId, null);
                console.log('Cleared password via saveLocalStorage(null)');
            }
        } catch (error) {
            console.error('Failed to clear password:', error);
        }
    }
}

module.exports = YandexCalendarIntegrationPlugin