
require('dotenv').config();

const { registerNavigation } = require('./navigation');
const { registerPromptMenu } = require('./prompt-menu');
const { Telegraf, Markup } = require('telegraf');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fs = require('fs');
const path = require('path');
const { registerSettings, getSettings } = require('./settings');

const { startMonitor } = require('./monitor');

const {
  saveProject,
  getProject,
  getDraft,
  saveDraft,
  saveOffer,
  getOffer
} = require('./project-store');

const {
  generateReply,
  reviseReply
} = require('./ai');

if (!process.env.BOT_TOKEN || !process.env.CHAT_ID) {
  throw new Error('Укажи BOT_TOKEN и CHAT_ID в .env');
}

// SnowVPN
const agent = process.env.TELEGRAM_PROXY_URL
  ? new SocksProxyAgent(process.env.TELEGRAM_PROXY_URL)
  : undefined;

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { agent }
});

// Ожидаемые правки от пользователя

const pendingEdits = new Map();
const pendingOffers = new Map();

let cancelSettingsInput = () => {};
let cancelPromptInput = () => {};

// Регистрируем навигацию первой,
// чтобы кнопка «Меню» работала даже во время ввода.
registerNavigation(bot, (chatId) => {
  pendingEdits.delete(chatId);
  pendingOffers.delete(chatId);
  cancelSettingsInput(chatId);
  cancelPromptInput(chatId);
});

// Настройки мониторинга
({ cancelSettingsInput } = registerSettings(
  bot,
  (chatId) => {
    pendingEdits.delete(chatId);
    cancelPromptInput(chatId);
  }
));

// Редактирование промпта ИИ
({ cancelPromptInput } = registerPromptMenu(
  bot,
  (chatId) => {
    pendingEdits.delete(chatId);
    cancelSettingsInput(chatId);
  }
));


// Защита от повторных запросов к GPT
const busy = new Set();

// Проверка доступа
const allowed = (ctx) =>
  String(ctx.chat?.id) === String(process.env.CHAT_ID);

// Кнопки под сгенерированным откликом
function draftButtons(id) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '✏️ Редактировать',
        `edit:${id}`
      ),
      Markup.button.callback(
        '🔄 Новый вариант',
        `reply:${id}`
      )
    ]
  ]);
}

bot.command('ping', (ctx) => {
  return ctx.reply('✅ Бот работает!');
});

bot.command('id', (ctx) => {
  return ctx.reply(`Твой Chat ID: ${ctx.chat.id}`);
});

bot.command('status', (ctx) => {
  if (!allowed(ctx)) return ctx.reply('Нет доступа');

  const file = path.join(
    __dirname,
    'seen-projects.json'
  );

  if (!fs.existsSync(file)) {
    return ctx.reply('История проектов пока не создана');
  }

  const state = JSON.parse(
    fs.readFileSync(file, 'utf8')
  );

  const settings = getSettings();

  return ctx.reply(
    '📊 Kwork Monitor\n\n' +
    `📂 Категорий: ${settings.categories.length}\n` +
    `📋 Сохранено проектов: ${state.ids.length}\n` +
    `🕒 Начальная дата: ${state.cutoff}\n` +
    `🔄 Интервал: ${settings.intervalMinutes} мин\n` +
    `🌐 Фильтр веб-тематики: ${settings.webOnly ? 'вкл' : 'выкл'}`
  );
});

// Тестовое объявление
bot.command('demo', async (ctx) => {
  if (!allowed(ctx)) return ctx.reply('Нет доступа');

  const id = `demo-${Date.now()}`;

  saveProject({
    id,
    name: 'Исправить форму на WordPress',
    description:
      'После обновления плагинов перестала ' +
      'отправляться форма заявки. ' +
      'Нужно найти причину и исправить.',
    priceLimit: '5000.00',
    category_id: '38',
    date_create: new Date().toISOString()
  });

  return ctx.reply(
    '🧪 Тестовое объявление\n\n' +
    '📌 Исправить форму на WordPress\n' +
    '💰 Бюджет: 5 000 ₽\n\n' +
    'После обновления плагинов перестала ' +
    'отправляться форма заявки.',
    Markup.inlineKeyboard([
      Markup.button.callback(
        '✍️ Текст ответа',
        `reply:${id}`
      )
    ])
  );
});

// Кнопка "Текст ответа"

bot.action(/^reply:([\w-]+)$/, async (ctx) => {
  if (!allowed(ctx)) {
    return ctx.answerCbQuery('Нет доступа');
  }

  await ctx.answerCbQuery();

  const id = ctx.match[1];
  const project = getProject(id);

  if (!project) {
    return ctx.reply('Проект не найден.');
  }

  if (busy.has(id)) {
    return ctx.reply('Запрос к GPT уже выполняется.');
  }

  const chatId = String(ctx.chat.id);

  // Отменяем другие режимы ввода
  pendingEdits.delete(chatId);
  cancelSettingsInput(chatId);
  cancelPromptInput(chatId);

  // Начинаем ввод условий
  pendingOffers.set(chatId, {
    id,
    step: 'price'
  });

  const previous = getOffer(id);

  const hint = previous
    ? `\nРанее: ${previous.priceRub} ₽, ${previous.term}`
    : '';

  return ctx.reply(
    'Укажи стоимость выполнения проекта в рублях.\n' +
    'Например: 5000' +
    hint,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          'Отменить',
          'nav:cancel'
        )
      ]
    ])
  );
});


// Кнопка "Редактировать"
bot.action(/^edit:([\w-]+)$/, async (ctx) => {
  if (!allowed(ctx)) {
    return ctx.answerCbQuery(
      'Нет доступа',
      { show_alert: true }
    );
  }

  await ctx.answerCbQuery();

  const id = ctx.match[1];
  const draft = getDraft(id);

  if (!draft) {
    return ctx.reply(
      'Сначала нажми «Текст ответа».'
    );
  }

  cancelSettingsInput(String(ctx.chat.id));
  cancelPromptInput(String(ctx.chat.id));
  pendingOffers.delete(String(ctx.chat.id));

  // Запоминаем, какой текст нужно исправить
  pendingEdits.set(String(ctx.chat.id), {
    id,
    draft
  });

  return ctx.reply(
    'Напиши, что изменить в отклике.\n' +
    'Например: «Сделай короче и убери вопрос в конце».',
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          'Отменить',
          'nav:cancel'
        )
      ]
    ])
  );
});

// Отмена редактирования и ввода настроек
bot.command('cancel', (ctx) => {
  if (!allowed(ctx)) {
    return ctx.reply('Нет доступа');
  }

  const chatId = String(ctx.chat.id);

  pendingEdits.delete(chatId);
  pendingOffers.delete(chatId);
  cancelSettingsInput(chatId);
  cancelPromptInput(chatId);

  return ctx.reply('Действие отменено.');
});

// Ввод стоимости и срока для GPT-отклика
bot.use(async (ctx, next) => {
  if (!allowed(ctx)) return next();

  const message = ctx.message?.text;

  if (!message || message.startsWith('/')) {
    return next();
  }

  const chatId = String(ctx.chat.id);
  const pending = pendingOffers.get(chatId);

  if (!pending) return next();

  const text = message.trim();

  const cancelKeyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        'Отменить',
        'nav:cancel'
      )
    ]
  ]);

  // Шаг 1. Получаем стоимость
  if (pending.step === 'price') {
    const raw = text
      .replace(/[\s\u00A0\u202F]/g, '')
      .replace(/(?:руб(?:лей|ля|\.)?|₽)$/i, '');

    if (!/^\d{1,9}$/.test(raw) || Number(raw) <= 0) {
      return ctx.reply(
        'Введи стоимость числом, например: 5000'
      );
    }

    pending.priceRub = Number(raw);
    pending.step = 'term';

    return ctx.reply(
      'Укажи срок выполнения проекта.\n' +
      'Например: 3 рабочих дня, 24 часа, 1 неделя.',
      cancelKeyboard
    );
  }

  // Шаг 2. Получаем срок
  if (pending.step === 'term') {
    if (!text || text.length > 120) {
      return ctx.reply(
        'Укажи срок текстом, до 120 символов.'
      );
    }

    const offer = {
      priceRub: pending.priceRub,
      term: text
    };

    const project = getProject(pending.id);

    if (!project) {
      pendingOffers.delete(chatId);
      return ctx.reply('Проект не найден.');
    }

    if (busy.has(pending.id)) {
      return ctx.reply('Запрос уже выполняется.');
    }

    pendingOffers.delete(chatId);
    busy.add(pending.id);

    try {
      // Сохраняем условия проекта
      saveOffer(pending.id, offer);

      await ctx.reply(
        'Генерирую отклик...\n\n' +
        `Стоимость: ${offer.priceRub.toLocaleString('ru-RU')} ₽\n` +
        `Срок: ${offer.term}`
      );

      // Генерация через GPT
      const reply = await generateReply(
        project,
        offer
      );

      saveDraft(pending.id, reply);

      return ctx.reply(
        `Отклик для проекта «${project.name}»:\n\n${reply}`,
        draftButtons(pending.id)
      );

    } catch (error) {
      console.error('Ошибка GPT:', error);

      return ctx.reply(
        'Не удалось сгенерировать отклик. ' +
        'Нажми «Текст ответа» ещё раз.'
      );

    } finally {
      busy.delete(pending.id);
    }
  }

  return next();
});


// Получаем текст правок
bot.on('text', async (ctx) => {
  if (!allowed(ctx)) return;
  if (ctx.message.text.startsWith('/')) return;

  const key = String(ctx.chat.id);
  const pending = pendingEdits.get(key);

  if (!pending) return;

  if (busy.has(pending.id)) {
    return ctx.reply('⏳ Запрос уже выполняется.');
  }

  const project = getProject(pending.id);

  if (!project) {
    return ctx.reply('Проект не найден в истории.');
  }

  pendingEdits.delete(key);
  busy.add(pending.id);

  try {
    await ctx.reply('⏳ Вношу правки...');

    const revised = await reviseReply(
      project,
      pending.draft,
      ctx.message.text,
      getOffer(pending.id)
    );

    // Перезаписываем предыдущий черновик
    saveDraft(pending.id, revised);

    await ctx.reply(
      `✅ Исправленный отклик:\n\n${revised}`,
      draftButtons(pending.id)
    );
  } catch (error) {
    console.error('Ошибка редактирования:', error);

    pendingEdits.set(key, pending);

    await ctx.reply(
      '❌ Не удалось применить правки. ' +
      'Отправь их повторно или нажми /cancel.'
    );
  } finally {
    busy.delete(pending.id);
  }
});

// Обработка ошибок
bot.catch((error) => {
  console.error('Ошибка Telegram:', error);
});

// Запуск
console.log('Запускаем Telegram-бота...');

bot.launch()
  .then(() => console.log('✅ Telegram-бот запущен'))
  .catch((error) =>
    console.error('Ошибка запуска Telegram:', error)
  );

console.log('Запускаем мониторинг Kwork...');

startMonitor(bot).catch((error) => {
  console.error('Ошибка мониторинга:', error);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
