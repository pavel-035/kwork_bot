
const fs = require('fs');
const path = require('path');
const { Markup } = require('telegraf');

const FILE = path.join(__dirname, 'monitor-settings.json');
const CATALOG_FILE = path.join(__dirname, 'kwork-catalog.json');

if (!fs.existsSync(CATALOG_FILE)) {
  throw new Error('Не найден kwork-catalog.json');
}

const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));

const allCategories = catalog.flatMap(g => g.categories || []);
const byId = new Map(allCategories.map(c => [String(c.id), c]));

const CATEGORIES = Object.fromEntries(
  allCategories.map(c => [String(c.id), c.name])
);

const DEFAULTS = {
  categories: ['37', '38', '41', '79', '255', '81'],
  attributesByCategory: {},
  intervalMinutes: 3,
  minBudget: 0,
  includeKeywords: [],
  excludeKeywords: [],
  webOnly: true
};

function getSettings() {
  const saved = fs.existsSync(FILE)
    ? JSON.parse(fs.readFileSync(FILE, 'utf8'))
    : {};

  return {
    ...DEFAULTS,
    ...saved,
    categories: (saved.categories ?? DEFAULTS.categories).map(String),
    attributesByCategory: saved.attributesByCategory || {},
    includeKeywords: saved.includeKeywords || [],
    excludeKeywords: saved.excludeKeywords || []
  };
}

function saveSettings(patch) {
  const result = { ...getSettings(), ...patch };
  fs.writeFileSync(FILE, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

function getAttributes(categoryId) {
  const attrs = byId.get(String(categoryId))?.attributes || {};

  return Object.values(attrs)
    .filter(a => a && a.id != null && String(a.visible) !== '0')
    .map(a => ({
      id: String(a.id),
      name: a.title || String(a.id)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// Формируем фильтры для мониторинга
function getTargets(settings = getSettings()) {
  const targets = [];
  const full = new Set(settings.categories.map(String));

  for (const categoryId of full) {
    if (!byId.has(categoryId)) continue;

    targets.push({
      key: `c:${categoryId}`,
      categoryId,
      name: CATEGORIES[categoryId]
    });
  }

  for (const [categoryId, ids] of Object.entries(settings.attributesByCategory)) {
    if (full.has(categoryId) || !byId.has(categoryId)) continue;

    const valid = new Set(getAttributes(categoryId).map(a => a.id));

    for (const attributeId of new Set(ids.map(String))) {
      if (!valid.has(attributeId)) continue;

      targets.push({
        key: `c:${categoryId}:a:${attributeId}`,
        categoryId,
        attributeId,
        name: CATEGORIES[categoryId]
      });
    }
  }

  return targets;
}


function registerSettings(bot, onBeginInput = () => {}) {
  const pendingInputs = new Map();
  const drafts = new Map();

  const allowed = ctx =>
    String(ctx.chat?.id) === String(process.env.CHAT_ID);

  const keyOf = ctx => String(ctx.chat.id);

  const button = (text, action) =>
    Markup.button.callback(text, action);

  // Создаём временную копию настроек категорий
  function beginEditing(ctx) {
    const s = getSettings();

    drafts.set(keyOf(ctx), {
      categories: new Set(s.categories.map(String)),
      attributesByCategory: Object.fromEntries(
        Object.entries(s.attributesByCategory || {})
          .map(([id, ids]) => [
            id,
            Array.isArray(ids) ? ids.map(String) : []
          ])
      )
    });
  }

  function getDraft(ctx) {
    return drafts.get(keyOf(ctx));
  }

  function editButtons() {
    return [
      [
        button('Сохранить', 'cfg:save'),
        button('Отменить', 'cfg:cancel')
      ]
    ];
  }

  // Главное меню

  function mainView() {
    const s = getSettings();

    const count = new Set([
      ...s.categories,
      ...Object.entries(s.attributesByCategory || {})
        .filter(([, ids]) => ids.length)
        .map(([id]) => id)
    ]).size;

    const interval = s.intervalMinutes < 1
      ? `${Math.round(s.intervalMinutes * 60)} сек`
      : `${s.intervalMinutes} мин`;

    return {
      text: [
        'Настройки мониторинга',
        '',
        `Категорий: ${count}`,
        `Интервал: ${interval}`,
        `Бюджет от: ${s.minBudget || 'любого'} ₽`,
        `Ключевые слова: ${s.includeKeywords.join(', ') || 'нет'}`,
        `Стоп-слова: ${s.excludeKeywords.join(', ') || 'нет'}`,
        `Только веб: ${s.webOnly ? 'да' : 'нет'}`
      ].join('\n'),

      keyboard: Markup.inlineKeyboard([
        [button('Категории', 'cfg:groups')],
        [button('Интервал проверки', 'cfg:input:interval')],
        [button('Минимальный бюджет', 'cfg:input:budget')],
        [button('Ключевые слова', 'cfg:input:include')],
        [button('Стоп-слова', 'cfg:input:exclude')],
        [
          button(
            `Только веб: ${s.webOnly ? 'да' : 'нет'}`,
            'cfg:web'
          )
        ],
        [button('Промпт ИИ', 'cfg:prompt')],
        [button('Назад', 'nav:settings')]
      ])
    };
  }

  // Список основных разделов
  function groupsView() {
    return {
      text: 'Выбери раздел Kwork:',
      keyboard: Markup.inlineKeyboard([
        ...catalog.map(group => [
          button(group.name, `cfg:group:${group.id}`)
        ]),
        ...editButtons()
      ])
    };
  }

  // Категории внутри раздела
  function groupView(ctx, groupId) {
    const group = catalog.find(
      g => String(g.id) === String(groupId)
    );

    if (!group) return groupsView();

    const draft = getDraft(ctx);

    const rows = group.categories.map(cat => {
      const id = String(cat.id);
      const count = (draft.attributesByCategory[id] || []).length;

      const mark = draft.categories.has(id)
        ? '[x]'
        : count ? `[${count}]` : '[ ]';

      return [
        button(`${mark} ${cat.name}`, `cfg:open:${id}:0`)
      ];
    });

    return {
      text: `${group.name}\n\nВыбери категории:`,
      keyboard: Markup.inlineKeyboard([
        ...rows,
        [button('Назад', 'cfg:groups')],
        ...editButtons()
      ])
    };
  }

  // Подкатегории
  function categoryView(ctx, categoryId, page = 0) {
    const id = String(categoryId);
    const category = byId.get(id);

    if (!category) return groupsView();

    const draft = getDraft(ctx);
    const attrs = getAttributes(id);

    const selected = new Set(
      draft.attributesByCategory[id] || []
    );

    const pages = Math.max(1, Math.ceil(attrs.length / 8));
    page = Math.max(0, Math.min(page, pages - 1));

    const rows = [
      [
        button(
          `${draft.categories.has(id) ? '[x]' : '[ ]'} Вся категория`,
          `cfg:whole:${id}:${page}`
        )
      ]
    ];

    for (const attr of attrs.slice(page * 8, page * 8 + 8)) {
      rows.push([
        button(
          `${selected.has(attr.id) ? '[x]' : '[ ]'} ${attr.name}`,
          `cfg:attr:${id}:${attr.id}:${page}`
        )
      ]);
    }

    if (pages > 1) {
      const navigation = [];

      if (page > 0) {
        navigation.push(
          button('Назад', `cfg:open:${id}:${page - 1}`)
        );
      }

      if (page < pages - 1) {
        navigation.push(
          button('Далее', `cfg:open:${id}:${page + 1}`)
        );
      }

      rows.push(navigation);
    }

    const parent = catalog.find(g =>
      g.categories.some(c => String(c.id) === id)
    );

    rows.push([
      button('К категориям', `cfg:group:${parent.id}`)
    ]);

    rows.push(...editButtons());

    return {
      text: `${category.name}\n\nОтметь нужные подкатегории.`,
      keyboard: Markup.inlineKeyboard(rows)
    };
  }

  async function show(ctx, view, edit = true) {
    const data = view();

    if (edit) {
      return ctx.editMessageText(data.text, data.keyboard);
    }

    return ctx.reply(data.text, data.keyboard);
  }

  async function navigate(ctx, view) {
    if (!allowed(ctx)) {
      return ctx.answerCbQuery('Нет доступа');
    }

    if (!getDraft(ctx)) {
      await ctx.answerCbQuery('Открой настройки заново');
      return ctx.reply('Отправь /settings');
    }

    await ctx.answerCbQuery();
    return show(ctx, view);
  }

  // Главное меню
  bot.command('settings', ctx => {
    if (!allowed(ctx)) return;

    pendingInputs.delete(keyOf(ctx));
    drafts.delete(keyOf(ctx));

    return show(ctx, mainView, false);
  });

  bot.action('cfg:main', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

    await ctx.answerCbQuery();
    return show(ctx, mainView);
  });

  // Начинаем редактирование категорий
  bot.action('cfg:groups', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

    if (!getDraft(ctx)) {
      beginEditing(ctx);
    }

    await ctx.answerCbQuery();
    return show(ctx, groupsView);
  });

  bot.action(/^cfg:group:(\d+)$/, ctx =>
    navigate(ctx, () => groupView(ctx, ctx.match[1]))
  );

  bot.action(/^cfg:open:(\d+):(\d+)$/, ctx =>
    navigate(ctx, () =>
      categoryView(ctx, ctx.match[1], Number(ctx.match[2]))
    )
  );

  // Выбор всей категории — только в памяти
  bot.action(/^cfg:whole:(\d+):(\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

    const draft = getDraft(ctx);
    if (!draft) return ctx.answerCbQuery('Открой настройки заново');

    const id = ctx.match[1];
    const page = Number(ctx.match[2]);

    if (draft.categories.has(id)) {
      draft.categories.delete(id);
    } else {
      draft.categories.add(id);
      delete draft.attributesByCategory[id];
    }

    await ctx.answerCbQuery('Изменено');

    const view = categoryView(ctx, id, page);

    return ctx.editMessageReplyMarkup(
      view.keyboard.reply_markup
    );
  });

  // Выбор подкатегории — только в памяти
  bot.action(/^cfg:attr:(\d+):(\d+):(\d+)$/, async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

    const draft = getDraft(ctx);
    if (!draft) return ctx.answerCbQuery('Открой настройки заново');

    const id = ctx.match[1];
    const attrId = ctx.match[2];
    const page = Number(ctx.match[3]);

    if (!getAttributes(id).some(a => a.id === attrId)) {
      return ctx.answerCbQuery('Подкатегория не найдена');
    }

    draft.categories.delete(id);

    const selected = new Set(
      draft.attributesByCategory[id] || []
    );

    if (selected.has(attrId)) {
      selected.delete(attrId);
    } else {
      selected.add(attrId);
    }

    if (selected.size) {
      draft.attributesByCategory[id] = [...selected];
    } else {
      delete draft.attributesByCategory[id];
    }

    await ctx.answerCbQuery('Изменено');

    const view = categoryView(ctx, id, page);

    return ctx.editMessageReplyMarkup(
      view.keyboard.reply_markup
    );
  });

  // Сохранение всех выбранных категорий
  bot.action('cfg:save', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

    const draft = getDraft(ctx);
    if (!draft) return ctx.answerCbQuery('Нет изменений');

    saveSettings({
      categories: [...draft.categories],
      attributesByCategory: draft.attributesByCategory
    });

    drafts.delete(keyOf(ctx));

    await ctx.answerCbQuery('Сохранено');
    return show(ctx, mainView);
  });

  // Отмена всех изменений категорий
  bot.action('cfg:cancel', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

    drafts.delete(keyOf(ctx));

    await ctx.answerCbQuery('Изменения отменены');
    return show(ctx, mainView);
  });

  // Веб-фильтр
  bot.action('cfg:web', async ctx => {
    if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

    saveSettings({ webOnly: !getSettings().webOnly });

    await ctx.answerCbQuery('Сохранено');
    return show(ctx, mainView);
  });

  // Ввод остальных настроек
  const prompts = {
    interval: 'Введи интервал: 30с, 1м, 5м или 0.5 (минуты). Минимум 30 секунд.',
    budget: 'Введи минимальный бюджет в рублях. 0 — без ограничения.',
    include: 'Введи ключевые слова через запятую. - для очистки.',
    exclude: 'Введи стоп-слова через запятую. - для очистки.'
  };

  bot.action(
    /^cfg:input:(interval|budget|include|exclude)$/,
    async ctx => {
      if (!allowed(ctx)) return ctx.answerCbQuery('Нет доступа');

      const type = ctx.match[1];
      const key = keyOf(ctx);

      pendingInputs.set(key, type);
      drafts.delete(key);
      onBeginInput(key);

      await ctx.answerCbQuery();
      return ctx.reply(
        prompts[type],
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              'Отменить',
              'nav:cancel'
            )
          ]
        ])
      );
    }
  );

  // Обработка введённого текста
  bot.use(async (ctx, next) => {
    if (!allowed(ctx)) return next();

    const text = ctx.message?.text;
    if (!text || text.startsWith('/')) return next();

    const key = keyOf(ctx);
    const type = pendingInputs.get(key);

    if (!type) return next();

    if (type === 'interval') {
      const raw = text.trim().toLowerCase().replace(',', '.');

      const seconds = raw.match(/^(\d+(?:\.\d+)?)\s*(?:с|сек|s)$/);
      const minutes = raw.match(/^(\d+(?:\.\d+)?)\s*(?:м|мин|m)?$/);

      const value = seconds
        ? Number(seconds[1]) / 60
        : minutes ? Number(minutes[1]) : NaN;

      if (!Number.isFinite(value) || value < 0.5 || value > 1440) {
        return ctx.reply('Интервал должен быть от 30 секунд до 24 часов.');
      }

      saveSettings({ intervalMinutes: value });

    } else if (type === 'budget') {
      const raw = text.replace(/\s/g, '');

      if (!/^\d{1,9}$/.test(raw)) {
        return ctx.reply('Введи целое число от 0 до 999999999.');
      }

      saveSettings({ minBudget: Number(raw) });

    } else {
      const words = text.trim() === '-'
        ? []
        : [...new Set(
          text.split(/[,;\n]+/)
            .map(w => w.trim().toLowerCase())
            .filter(Boolean)
        )];

      if (words.length > 20 || words.some(w => w.length > 80)) {
        return ctx.reply(
          'Максимум 20 слов или фраз, до 80 символов каждая.'
        );
      }

      saveSettings({
        [type === 'include'
          ? 'includeKeywords'
          : 'excludeKeywords']: words
      });
    }

    pendingInputs.delete(key);

    await ctx.reply('Сохранено.');
    return show(ctx, mainView, false);
  });

  return {
    cancelSettingsInput(chatId) {
      pendingInputs.delete(String(chatId));
      drafts.delete(String(chatId));
    }
  };
}


module.exports = {
  CATEGORIES,
  getSettings,
  getTargets,
  registerSettings
};
