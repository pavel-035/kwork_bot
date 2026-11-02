
const { Markup } = require('telegraf');
const { getAiPrompt, saveAiPrompt } = require('./ai');

function registerPromptMenu(bot, onBeginInput = () => {}) {
  const sessions = new Map();

  const allowed = ctx =>
    String(ctx.chat?.id) === String(process.env.CHAT_ID);

  const keyOf = ctx => String(ctx.chat.id);

  const button = (text, action) =>
    Markup.button.callback(text, action);

  // Показываем текущий промпт
  function showPrompt(ctx) {
    return ctx.reply(
      'Текущий промпт ИИ:\n\n' + getAiPrompt(),
      Markup.inlineKeyboard([
        [button('Изменить', 'prompt:edit')]
      ])
    );
  }

  // Отдельная команда /prompt
  bot.command('prompt', ctx => {
    if (!allowed(ctx)) return ctx.reply('Нет доступа');
    return showPrompt(ctx);
  });

  // Кнопка из меню настроек
  bot.action('cfg:prompt', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

    await ctx.answerCbQuery();
    return showPrompt(ctx);
  });

  // Начинаем редактирование
  bot.action('prompt:edit', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

    const key = keyOf(ctx);

    sessions.set(key, { step: 'input' });
    onBeginInput(key);

    await ctx.answerCbQuery();

    return ctx.reply(
      'Отправь новый промпт одним сообщением.\n\n' +
      'Он полностью заменит текущий после сохранения.\n' +
      'Для отмены используй /cancel.',
      Markup.forceReply()
    );
  });

  // Получаем новый текст промпта
  bot.use(async (ctx, next) => {
    if (!allowed(ctx)) return next();

    const text = ctx.message?.text;
    if (!text || text.startsWith('/')) return next();

    const key = keyOf(ctx);
    const session = sessions.get(key);

    if (!session || session.step !== 'input') {
      return next();
    }

    const prompt = text.trim();

    if (prompt.length < 20 || prompt.length > 3000) {
      return ctx.reply(
        'Промпт должен содержать от 20 до 3000 символов.'
      );
    }

    // Пока только сохраняем черновик в памяти
    sessions.set(key, {
      step: 'confirm',
      prompt
    });

    return ctx.reply(
      'Новый промпт:\n\n' +
      prompt +
      '\n\nСохранить изменения?',
      Markup.inlineKeyboard([
        [
          button('Сохранить', 'prompt:save'),
          button('Отменить', 'prompt:cancel')
        ]
      ])
    );
  });

  // Сохраняем промпт
  bot.action('prompt:save', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

    const key = keyOf(ctx);
    const session = sessions.get(key);

    if (!session || session.step !== 'confirm') {
      return ctx.answerCbQuery('Нет изменений');
    }

    try {
      saveAiPrompt(session.prompt);
      sessions.delete(key);

      await ctx.answerCbQuery('Сохранено');

      return ctx.reply(
        'Промпт сохранён.\n' +
        'Следующие запросы к GPT будут использовать его.'
      );
    } catch (error) {
      console.error('Ошибка сохранения промпта:', error);
      return ctx.answerCbQuery('Ошибка сохранения');
    }
  });

  // Отменяем изменения
  bot.action('prompt:cancel', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

    sessions.delete(keyOf(ctx));

    await ctx.answerCbQuery('Отменено');
    return ctx.reply('Изменения промпта отменены.');
  });

  return {
    cancelPromptInput(chatId) {
      sessions.delete(String(chatId));
    }
  };
}

module.exports = { registerPromptMenu };
