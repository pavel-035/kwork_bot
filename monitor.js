
require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { Markup } = require('telegraf');
const { saveProject } = require('./project-store');
const { CATEGORIES, getSettings, getTargets } = require('./settings');

const STATE_FILE = path.join(__dirname, 'seen-projects.json');

const proxyUrl = process.env.TELEGRAM_PROXY_URL;
const agent = proxyUrl
  ? new SocksProxyAgent(proxyUrl)
  : undefined;

const sleep = (ms) =>
  new Promise(resolve => setTimeout(resolve, ms));

// Извлечение JSON из HTML
function extractStateData(html) {
  const match = /(?:window\.)?stateData\s*=\s*/.exec(html);

  if (!match) {
    throw new Error('stateData не найден');
  }

  let start = match.index + match[0].length;

  while (/\s/.test(html[start] || '')) start++;

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '[';

      if (stack.pop() !== expected) {
        throw new Error('Некорректная структура JSON');
      }

      if (stack.length === 0) {
        return JSON.parse(html.slice(start, i + 1));
      }
    }
  }

  throw new Error('Не удалось извлечь stateData');
}

// Загрузка проектов из всех категорий
async function fetchProjects(targets) {
  const all = new Map();
  const succeeded = new Set();

  for (const target of targets) {
    const url = new URL('https://kwork.ru/projects');

    url.searchParams.set('c', target.categoryId);

    if (target.attributeId) {
      url.searchParams.set('attr', target.attributeId);
    }

    try {
      const response = await axios.get(url.toString(), {
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'text/html'
        }
      });

      const data = extractStateData(response.data);
      const params = data.urlParametersView || {};
      const projects = data.wantsListData?.pagination?.data;

      if (!Array.isArray(projects)) {
        throw new Error('Список проектов отсутствует');
      }

      if (String(params.c) !== target.categoryId) {
        throw new Error('Kwork не применил фильтр категории');
      }

      // Проверяем, что фильтр подкатегории действительно применён
      if (target.attributeId) {
        const appliedIds = String(
          Array.isArray(params.attr)
            ? params.attr.join(',')
            : params.attr ?? ''
        ).match(/\d+/g) || [];

        if (!appliedIds.includes(target.attributeId)) {
          throw new Error('Kwork не подтвердил фильтр attr');
        }
      }

      succeeded.add(target.key);

      console.log(
        `${target.name}` +
        (target.attributeId ? ` / ${target.attributeId}` : '') +
        `: ${projects.length} проектов`
      );

      for (const project of projects) {
        if (project?.id == null) continue;

        const id = String(project.id);

        if (!all.has(id)) {
          const username = [
            project.username,
            project.user_name,
            project.user?.username,
            project.buyer?.username
          ].find(value =>
            typeof value === 'string' && value.trim()
          ) || '';

          all.set(id, {
            ...project,
            username: username.trim(),
            _sources: []
          });
        }

        all.get(id)._sources.push(target.key);
      }
    } catch (error) {
      console.error(
        `Ошибка фильтра ${target.key}: ${error.message}`
      );
    }

    await sleep(1000);
  }

  return {
    projects: [...all.values()],
    succeeded
  };
}


// Фильтр по тематике веб-разработки

function isRelevant(project, settings) {
  const category = String(project.category_id);

  const text = `${project.name} ${project.description || ''}`
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase();

  // Минимальный бюджет
  const budget = Number(project.priceLimit);

  if (settings.minBudget > 0) {
    if (
      !Number.isFinite(budget) ||
      budget < settings.minBudget
    ) {
      return false;
    }
  }

  // Стоп-слова: исключаем совпадения
  if (
    settings.excludeKeywords.some(word =>
      text.includes(word.toLowerCase())
    )
  ) {
    return false;
  }

  // Ключевые слова: достаточно одного совпадения
  if (
    settings.includeKeywords.length > 0 &&
    !settings.includeKeywords.some(word =>
      text.includes(word.toLowerCase())
    )
  ) {
    return false;
  }

  // Дополнительный фильтр веб-тематики
  if (settings.webOnly) {
    // Эти категории считаем профильными
    if (['37', '38', '79'].includes(category)) {
      return true;
    }

    if (category === '255') {
      return /сайт|хостинг|домен|dns|ssl|веб|web|vps|сервер|почт|nginx|wordpress|перенос/i.test(text);
    }

    return /сайт|веб|web|wordpress|tilda|тильд|html|css|javascript|php|vue|nuxt|лендинг|frontend|фронтенд|интеграц|crm|api/i.test(text);
  }

  return true;
}

// Формируем сообщение Telegram
function formatProject(project) {
  const description = String(project.description || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);

  const budget = Number(project.priceLimit);

  return [
    '🆕 Новый проект Kwork',
    '',
    `📌 ${project.name}`,
    `👤 Заказчик: ${project.username || 'Не указан'}`,
    `📂 ${CATEGORIES[project.category_id] || 'Другое'}`,
    `💰 Бюджет: до ${budget.toLocaleString('ru-RU')} ₽`,
    `🕒 Создан: ${project.date_create}`,
    '',
    description,
    '',
    `🔗 https://kwork.ru/projects/${project.id}`
  ].join('\n');
}

// Сохраняем состояние
function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2),
    'utf8'
  );
}

// Одна проверка

async function checkProjects(bot) {
  const settings = getSettings();
  const targets = getTargets(settings);

  if (!targets.length) {
    console.log('Не выбрано ни одной категории или подкатегории');

    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(
        fs.readFileSync(STATE_FILE, 'utf8')
      );

      state.activeFilters = [];
      saveState(state);
    }

    return;
  }

  const { projects, succeeded } = await fetchProjects(targets);

  if (!succeeded.size) {
    throw new Error(
      'Не удалось получить проекты ни по одному фильтру'
    );
  }

  console.log(`Всего уникальных: ${projects.length}`);

  // Первоначальная загрузка
  if (!fs.existsSync(STATE_FILE)) {
    const dates = projects
      .map(p => p.date_create)
      .filter(Boolean)
      .sort();

    saveState({
      cutoff: dates.at(-1) || '',
      ids: projects.map(p => String(p.id)),
      initializedCategories: settings.categories.map(String),
      activeCategories: settings.categories.map(String),
      activeFilters: [...succeeded]
    });

    console.log('Первичная загрузка завершена');

    await bot.telegram.sendMessage(
      process.env.CHAT_ID,
      `Мониторинг запущен. Активных фильтров: ${succeeded.size}. Проектов: ${projects.length}.`
    );

    return;
  }

  const state = JSON.parse(
    fs.readFileSync(STATE_FILE, 'utf8')
  );

  const seen = new Set((state.ids || []).map(String));

  // Совместимость с существующим seen-projects.json
  const previouslyActive = new Set(
    state.activeFilters ||
    (
      state.activeCategories ||
      state.initializedCategories ||
      []
    ).map(id => `c:${id}`)
  );

  const newlyEnabled = new Set(
    [...succeeded].filter(key => !previouslyActive.has(key))
  );

  // Не отправляем старые заказы из только что включённых фильтров
  for (const project of projects) {
    if (project._sources.every(source => newlyEnabled.has(source))) {
      seen.add(String(project.id));
    }
  }

  state.activeFilters = targets
    .map(target => target.key)
    .filter(key =>
      previouslyActive.has(key) || succeeded.has(key)
    );

  state.activeCategories = [...settings.categories];

  state.initializedCategories = [
    ...new Set([
      ...(state.initializedCategories || []).map(String),
      ...settings.categories
    ])
  ];

  state.ids = [...seen];
  saveState(state);

  // Сортируем по дате создания, а не повторной активации
  projects.sort((a, b) =>
    String(a.date_create || '').localeCompare(
      String(b.date_create || '')
    )
  );

  let notified = 0;

  for (const project of projects) {
    const id = String(project.id);

    if (seen.has(id)) continue;

    if (
      project.date_create &&
      project.date_create > state.cutoff &&
      isRelevant(project, settings)
    ) {
      // Сохраняем проект для последующей генерации GPT
      saveProject(project);

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            'Текст ответа',
            `reply:${id}`
          )
        ],
        [
          Markup.button.url(
            'Открыть проект',
            `https://kwork.ru/projects/${id}`
          )
        ]
      ]);

      await bot.telegram.sendMessage(
        process.env.CHAT_ID,
        formatProject(project),
        {
          ...keyboard,
          link_preview_options: {
            is_disabled: true
          }
        }
      );

      notified++;
    }

    seen.add(id);
    state.ids = [...seen];
    saveState(state);
  }

  console.log(`Новых подходящих проектов: ${notified}`);
  return notified;
}


// Запуск периодического мониторинга


const CONTROL_FILE = path.join(
  __dirname,
  'monitor-control.json'
);

const control = fs.existsSync(CONTROL_FILE)
  ? JSON.parse(
    fs.readFileSync(CONTROL_FILE, 'utf8')
  )
  : { paused: false };

const monitorRuntime = {
  bot: null,
  running: false,
  lastStartedAt: 0,
  lastSuccessAt: null,
  lastError: null,
  newDuringSession: 0,
  paused: !!control.paused,
  timer: null
};

// Получение состояния мониторинга
function getMonitorStatus() {
  return {
    paused: monitorRuntime.paused,
    running: monitorRuntime.running,
    lastSuccessAt: monitorRuntime.lastSuccessAt,
    lastError: monitorRuntime.lastError,
    newDuringSession: monitorRuntime.newDuringSession
  };
}

// Сохранение паузы
function setPause(paused) {
  monitorRuntime.paused = paused;

  fs.writeFileSync(
    CONTROL_FILE,
    JSON.stringify({ paused }, null, 2),
    'utf8'
  );
}

function pauseMonitor() {
  setPause(true);
}

function resumeMonitor() {
  setPause(false);

  // Разрешаем ближайшую плановую проверку
  monitorRuntime.lastStartedAt = 0;
}

// Единая функция выполнения проверки
async function runCheck(manual = false) {
  if (!monitorRuntime.bot) {
    return {
      started: false,
      message: 'Бот ещё не запущен'
    };
  }

  if (monitorRuntime.running) {
    return {
      started: false,
      message: 'Проверка уже выполняется'
    };
  }

  if (monitorRuntime.paused && !manual) {
    return {
      started: false,
      message: 'Мониторинг на паузе'
    };
  }

  monitorRuntime.running = true;
  monitorRuntime.lastStartedAt = Date.now();

  try {
    const found = await checkProjects(
      monitorRuntime.bot
    );

    monitorRuntime.lastSuccessAt =
      new Date().toISOString();

    monitorRuntime.lastError = null;

    monitorRuntime.newDuringSession +=
      Number(found) || 0;

    return {
      started: true,
      found: Number(found) || 0
    };

  } catch (error) {
    monitorRuntime.lastError = error.message;

    console.error(
      'Ошибка мониторинга:',
      error.message
    );

    return {
      started: true,
      error: error.message
    };

  } finally {
    monitorRuntime.running = false;
  }
}

// Ручная проверка — доступна и во время паузы
function checkNow() {
  return runCheck(true);
}

// Запуск планового мониторинга
async function startMonitor(bot) {
  if (!process.env.CHAT_ID) {
    throw new Error('CHAT_ID не указан в .env');
  }

  monitorRuntime.bot = bot;

  if (!monitorRuntime.timer) {
    monitorRuntime.timer = setInterval(() => {
      const intervalMs =
        getSettings().intervalMinutes * 60 * 1000;

      if (
        !monitorRuntime.paused &&
        !monitorRuntime.running &&
        Date.now() - monitorRuntime.lastStartedAt >= intervalMs
      ) {
        void runCheck();
      }
    }, 10000);
  }

  return runCheck();
}

module.exports = {
  startMonitor,
  getMonitorStatus,
  pauseMonitor,
  resumeMonitor,
  checkNow
};

