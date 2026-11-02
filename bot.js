
require('dotenv').config();

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
  saveDraft
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

let cancelPromptInput = () => {};

const { cancelSettingsInput } = registerSettings(
  bot,
  (chatId) => {
    pendingEdits.delete(chatId);
    cancelPromptInput(chatId);
  }
);

cancelPromptInput = registerPromptMenu(
  bot,
  (chatId) => {
    pendingEdits.delete(chatId);
    cancelSettingsInput(chatId);
  }
).cancelPromptInput;

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

// Основные команды
bot.start((ctx) => {
  return ctx.reply(
    'Привет! Kwork Monitor запущен.\n' +
    'Для проверки используй /demo.'
  );
});

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
    return ctx.answerCbQuery(
      'Нет доступа',
      { show_alert: true }
    );
  }

  await ctx.answerCbQuery();

  const id = ctx.match[1];
  const project = getProject(id);

  if (!project) {
    return ctx.reply(
      'Проект не найден в истории. ' +
      'Дождись нового уведомления или вызови /demo.'
    );
  }

  if (busy.has(id)) {
    return ctx.reply('⏳ Запрос к GPT уже выполняется.');
  }

  busy.add(id);

  try {
    await ctx.reply('⏳ Генерирую отклик...');

    const reply = await generateReply(project);

    // Сохраняем полученный текст
    saveDraft(id, reply);

    await ctx.reply(
      `✍️ Отклик для проекта «${project.name}»:\n\n${reply}`,
      draftButtons(id)
    );
  } catch (error) {
    console.error('Ошибка генерации:', error);

    await ctx.reply(
      '❌ GPT не смог сгенерировать отклик. ' +
      'Попробуй ещё раз.'
    );
  } finally {
    busy.delete(id);
  }
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

  // Запоминаем, какой текст нужно исправить
  pendingEdits.set(String(ctx.chat.id), {
    id,
    draft
  });

  return ctx.reply(
    '✏️ Напиши, что изменить в отклике.\n\n' +
    'Например: «Сделай короче и убери вопрос в конце».\n\n' +
    'Для отмены отправь /cancel.',
    Markup.forceReply()
  );
});

// Отмена редактирования и ввода настроек
bot.command('cancel', (ctx) => {
  if (!allowed(ctx)) return ctx.reply('Нет доступа');

  pendingEdits.delete(String(ctx.chat.id));
  cancelSettingsInput(String(ctx.chat.id));
  cancelPromptInput(String(ctx.chat.id));

  return ctx.reply('✅ Действие отменено.');
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
      ctx.message.text
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
