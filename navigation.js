
const fs = require('fs');
const path = require('path');
const { Markup } = require('telegraf');
const { getSettings, getTargets } = require('./settings');

const {
  getProject,
  getDraft,
  getDraftHistory,
  restoreDraft,
  listProjects,
  markRead,
  setHidden,
  getCounts,
  saveProject
} = require('./project-store');

const {
  getMonitorStatus,
  pauseMonitor,
  resumeMonitor,
  checkNow
} = require('./monitor');

const button = (label, action) =>
  Markup.button.callback(label, action);

const PAGE_SIZE = 6;
const STARTED = new Set();

function registerNavigation(bot, cancelInput = () => {}) {
  const allowed = ctx =>
    String(ctx.chat?.id) === String(process.env.CHAT_ID);

  function homeView() {
    const s = getSettings();
    const status = getMonitorStatus();
    const c = getCounts();

    const interval = s.intervalMinutes < 1
      ? Math.round(s.intervalMinutes * 60) + ' сек'
      : s.intervalMinutes + ' мин';

    return {
      text:
        'Kwork Monitor\n\n' +
        `Мониторинг: ${status.paused ? 'пауза' : status.running ? 'проверяет' : 'включён'}\n` +
        `Интервал: ${interval}\n` +
        `Фильтров: ${getTargets(s).length}\n` +
        `Непросмотренных: ${c.unread}`,

      keyboard: Markup.inlineKeyboard([
        [
          button('Проекты', 'nav:projects'),
          button('Черновики', 'nav:list:drafts:0')
        ],
        [
          button('Мониторинг', 'nav:monitor'),
          button('Настройки', 'nav:settings')
        ]
      ])
    };
  }

  async function display(ctx, data, edit = false) {
    if (!edit) {
      return ctx.reply(data.text, data.keyboard);
    }

    try {
      return await ctx.editMessageText(
        data.text,
        data.keyboard
      );
    } catch (error) {
      if (
        error.description?.includes('message is not modified')
      ) {
        return;
      }
      throw error;
    }
  }

  async function action(ctx, createView) {
    if (!allowed(ctx)) {
      return ctx.answerCbQuery('Нет доступа');
    }

    await ctx.answerCbQuery();
    return display(ctx, createView(), true);
  }

  const menuKeyboard = Markup.keyboard([
    ['Меню']
  ]).resize().persistent();

  async function openHome(ctx, edit = false) {
    cancelInput(String(ctx.chat.id));

    if (
      !edit &&
      !STARTED.has(String(ctx.chat.id))
    ) {
      STARTED.add(String(ctx.chat.id));

      await ctx.reply(
        'Управление ботом — через кнопку «Меню» внизу.',
        menuKeyboard
      );
    }

    return display(ctx, homeView(), edit);
  }

  // Вход в главное меню
  bot.start(ctx => {
    if (!allowed(ctx)) return ctx.reply('Нет доступа');
    return openHome(ctx);
  });

  bot.hears('Меню', ctx => {
    if (!allowed(ctx)) return;
    return openHome(ctx);
  });

  bot.action('nav:home', ctx => {
    cancelInput(String(ctx.chat.id));
    return action(ctx, homeView);
  });

  // Универсальная отмена ввода
  bot.action('nav:cancel', async ctx => {
    if (!allowed(ctx)) {
      return ctx.answerCbQuery('Нет доступа');
    }

    cancelInput(String(ctx.chat.id));
    await ctx.answerCbQuery('Отменено');

    return display(ctx, homeView(), true);
  });

  // Раздел проектов
  function projectsView() {
    const c = getCounts();

    return {
      text:
        'Проекты\n\n' +
        `Всего: ${c.all}\n` +
        `Непросмотренных: ${c.unread}\n` +
        `Скрытых: ${c.hidden}\n\n` +
        'Выбери список:',

      keyboard: Markup.inlineKeyboard([
        [button('Последние', 'nav:list:all:0')],
        [
          button(
            `Непросмотренные (${c.unread})`,
            'nav:list:unread:0'
          )
        ],
        [button('Скрытые', 'nav:list:hidden:0')],
        [button('Главное меню', 'nav:home')]
      ])
    };
  }

  bot.action('nav:projects', ctx =>
    action(ctx, projectsView)
  );

  // Списки проектов и черновиков
  function listView(mode, page) {
    const all = listProjects(mode);
    const pages = Math.max(
      1,
      Math.ceil(all.length / PAGE_SIZE)
    );

    page = Math.max(0, Math.min(page, pages - 1));

    const rows = all
      .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .map(p => [
        button(
          `${!p.read && mode !== 'drafts' ? '• ' : ''}` +
          (p.name.slice(0, 48) || p.id),
          `nav:project:${p.id}:${mode}:${page}`
        )
      ]);

    if (pages > 1) {
      const nav = [];

      if (page > 0) {
        nav.push(
          button(
            'Назад',
            `nav:list:${mode}:${page - 1}`
          )
        );
      }

      if (page < pages - 1) {
        nav.push(
          button(
            'Далее',
            `nav:list:${mode}:${page + 1}`
          )
        );
      }

      rows.push(nav);
    }

    rows.push([
      button(
        mode === 'drafts'
          ? 'Главное меню'
          : 'К проектам',
        mode === 'drafts'
          ? 'nav:home'
          : 'nav:projects'
      )
    ]);

    const names = {
      all: 'Последние проекты',
      unread: 'Непросмотренные',
      hidden: 'Скрытые',
      drafts: 'Черновики'
    };

    return {
      text: names[mode] + '\n\n' +
        (
          all.length
            ? `Записей: ${all.length} · Страница ${page + 1}/${pages}`
            : 'Список пуст'
        ),

      keyboard: Markup.inlineKeyboard(rows)
    };
  }

  bot.action(
    /^nav:list:(all|unread|hidden|drafts):(\d+)$/,
    ctx => action(
      ctx,
      () => listView(
        ctx.match[1],
        Number(ctx.match[2])
      )
    )
  );

  // Карточка проекта
  function projectView(id, mode = 'all', page = 0) {
    const project = getProject(id);

    if (!project) {
      return {
        text: 'Проект не найден.',
        keyboard: Markup.inlineKeyboard([
          [button('Назад', `nav:list:${mode}:${page}`)]
        ])
      };
    }

    const hidden = listProjects('hidden')
      .some(p => p.id === id);

    const description = String(project.description || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1800);

    const draft = getDraft(id);

    const rows = [
      [
        button(
          draft ? 'Новый вариант' : 'Текст ответа',
          `reply:${id}`
        )
      ],
      ...(
        draft
          ? [[button(
            'Посмотреть отклик',
            `nav:draft:${id}:${mode}:${page}`
          )]]
          : []
      ),
      [
        button(
          hidden ? 'Вернуть в список' : 'Скрыть',
          `nav:hide:${id}:${mode}:${page}`
        )
      ]
    ];

    if (!id.startsWith('demo-')) {
      rows.push([
        Markup.button.url(
          'Открыть Kwork',
          `https://kwork.ru/projects/${id}`
        )
      ]);
    }

    rows.push([
      button('Назад', `nav:list:${mode}:${page}`)
    ]);

    return {
      text:
        `${project.name}\n\n` +
        `Заказчик: ${project.username || 'Не указан'}\n` +
        `Бюджет: ${Number(project.priceLimit || 0).toLocaleString('ru-RU')} ₽\n` +
        `Создан: ${project.date_create || 'неизвестно'}\n\n` +
        description,

      keyboard: Markup.inlineKeyboard(rows)
    };
  }

  bot.action(
    /^nav:project:([\w-]+):(all|unread|hidden|drafts):(\d+)$/,
    async ctx => {
      if (!allowed(ctx)) {
        return ctx.answerCbQuery('Нет доступа');
      }

      markRead(ctx.match[1]);
      await ctx.answerCbQuery();

      return display(
        ctx,
        projectView(
          ctx.match[1],
          ctx.match[2],
          Number(ctx.match[3])
        ),
        true
      );
    }
  );

  // Скрыть или вернуть проект
  bot.action(
    /^nav:hide:([\w-]+):(all|unread|hidden|drafts):(\d+)$/,
    async ctx => {
      if (!allowed(ctx)) {
        return ctx.answerCbQuery('Нет доступа');
      }

      const id = ctx.match[1];

      const hidden = listProjects('hidden')
        .some(p => p.id === id);

      setHidden(id, !hidden);

      await ctx.answerCbQuery(
        hidden ? 'Восстановлено' : 'Скрыто'
      );

      return display(
        ctx,
        projectView(
          id,
          ctx.match[2],
          Number(ctx.match[3])
        ),
        true
      );
    }
  );

  // Просмотр готового отклика
  function draftView(id, mode = 'drafts', page = 0) {
    const project = getProject(id);
    const draft = getDraft(id);

    if (!project || !draft) {
      return {
        text: 'Черновик не найден.',
        keyboard: Markup.inlineKeyboard([
          [button('Назад', `nav:list:${mode}:${page}`)]
        ])
      };
    }

    const history = getDraftHistory(id);

    return {
      text:
        `Отклик: ${project.name}\n\n` +
        draft.slice(0, 3300),

      keyboard: Markup.inlineKeyboard([
        [
          button('Редактировать', `edit:${id}`),
          button('Новый вариант', `reply:${id}`)
        ],
        ...(
          history.length
            ? [[button(
              `История версий (${history.length})`,
              `nav:history:${id}:0`
            )]]
            : []
        ),
        [
          button(
            'К проекту',
            `nav:project:${id}:${mode}:${page}`
          )
        ],
        [
          button(
            'Назад',
            `nav:list:${mode}:${page}`
          )
        ]
      ])
    };
  }

  bot.action(
    /^nav:draft:([\w-]+):(all|unread|hidden|drafts):(\d+)$/,
    ctx => action(
      ctx,
      () => draftView(
        ctx.match[1],
        ctx.match[2],
        Number(ctx.match[3])
      )
    )
  );

  // История версий отклика
  function historyView(id, page = 0) {
    const history = getDraftHistory(id);

    const pages = Math.max(
      1,
      Math.ceil(history.length / 5)
    );

    page = Math.max(0, Math.min(page, pages - 1));

    const rows = history
      .slice(page * 5, page * 5 + 5)
      .map((text, n) => {
        const index = page * 5 + n;

        return [
          button(
            `Версия ${index + 1}: ${text.slice(0, 25)}`,
            `nav:restore:${id}:${index}`
          )
        ];
      });

    const navigation = [];

    if (page > 0) {
      navigation.push(
        button(
          'Назад',
          `nav:history:${id}:${page - 1}`
        )
      );
    }

    if (page < pages - 1) {
      navigation.push(
        button(
          'Далее',
          `nav:history:${id}:${page + 1}`
        )
      );
    }

    if (navigation.length) rows.push(navigation);

    rows.push([
      button(
        'К отклику',
        `nav:draft:${id}:drafts:0`
      )
    ]);

    return {
      text:
        'История отклика\n\n' +
        'Нажми версию, чтобы восстановить её.',
      keyboard: Markup.inlineKeyboard(rows)
    };
  }

  bot.action(
    /^nav:history:([\w-]+):(\d+)$/,
    ctx => action(
      ctx,
      () => historyView(
        ctx.match[1],
        Number(ctx.match[2])
      )
    )
  );

  bot.action(
    /^nav:restore:([\w-]+):(\d+)$/,
    async ctx => {
      if (!allowed(ctx)) {
        return ctx.answerCbQuery('Нет доступа');
      }

      try {
        restoreDraft(
          ctx.match[1],
          Number(ctx.match[2])
        );

        await ctx.answerCbQuery('Версия восстановлена');

        return display(
          ctx,
          draftView(ctx.match[1]),
          true
        );
      } catch (error) {
        return ctx.answerCbQuery(
          'Не удалось восстановить'
        );
      }
    }
  );

  // Раздел мониторинга
  function monitorView() {
    const s = getSettings();
    const m = getMonitorStatus();

    const file = path.join(
      __dirname,
      'seen-projects.json'
    );

    const seenCount = fs.existsSync(file)
      ? JSON.parse(
      fs.readFileSync(file, 'utf8')
    ).ids?.length ?? 0
      : 0;

    const interval = s.intervalMinutes < 1
      ? Math.round(s.intervalMinutes * 60) + ' сек'
      : s.intervalMinutes + ' мин';

    return {
      text: [
        'Мониторинг',
        '',
        `Состояние: ${m.paused ? 'пауза' : m.running ? 'проверка...' : 'работает'}`,
        `Интервал: ${interval}`,
        `Активных фильтров: ${getTargets(s).length}`,
        `Обработано проектов: ${seenCount}`,
        `Последняя проверка: ${
          m.lastSuccessAt
            ? new Date(m.lastSuccessAt).toLocaleString('ru-RU')
            : 'ещё не завершалась'
        }`,
        `Новых за запуск: ${m.newDuringSession}`,
        ...(
          m.lastError
            ? [`Последняя ошибка: ${String(m.lastError).slice(0, 150)}`]
            : []
        )
      ].join('\n'),

      keyboard: Markup.inlineKeyboard([
        [
          button(
            m.paused ? 'Запустить' : 'Приостановить',
            m.paused ? 'nav:resume' : 'nav:pause'
          )
        ],
        [
          button('Проверить сейчас', 'nav:check')
        ],
        [
          button('Обновить статус', 'nav:monitor')
        ],
        [
          button('Главное меню', 'nav:home')
        ]
      ])
    };
  }

  bot.action('nav:monitor', ctx =>
    action(ctx, monitorView)
  );

  bot.action('nav:pause', async ctx => {
    if (!allowed(ctx)) {
      return ctx.answerCbQuery('Нет доступа');
    }

    pauseMonitor();
    await ctx.answerCbQuery('Мониторинг приостановлен');

    return display(ctx, monitorView(), true);
  });

  bot.action('nav:resume', async ctx => {
    if (!allowed(ctx)) {
      return ctx.answerCbQuery('Нет доступа');
    }

    resumeMonitor();
    await ctx.answerCbQuery('Мониторинг запущен');

    return display(ctx, monitorView(), true);
  });

  bot.action('nav:check', async ctx => {
    if (!allowed(ctx)) {
      return ctx.answerCbQuery('Нет доступа');
    }

    await ctx.answerCbQuery('Проверяю');

    const result = await checkNow();

    if (!result.started) {
      return ctx.reply(
        result.message || 'Проверка уже выполняется'
      );
    }

    return ctx.reply(
      result.error
        ? `Проверка завершилась с ошибкой: ${result.error}`
        : `Проверка завершена. Новых подходящих: ${result.found ?? 0}`
    );
  });

  // Раздел настроек
  function settingsView() {
    return {
      text: 'Настройки\n\nВыбери раздел:',

      keyboard: Markup.inlineKeyboard([
        [
          button(
            'Фильтры, категории и интервал',
            'cfg:main'
          )
        ],
        // [
        //   button('Промпт ИИ', 'cfg:prompt')
        // ],
        [
          button('Тестовый проект', 'nav:demo')
        ],
        [
          button('Главное меню', 'nav:home')
        ]
      ])
    };
  }

  bot.action('nav:settings', ctx =>
    action(ctx, settingsView)
  );

  // Тестовый проект без ожидания Kwork
  bot.action('nav:demo', async ctx => {
    if (!allowed(ctx)) {
      return ctx.answerCbQuery('Нет доступа');
    }

    await ctx.answerCbQuery();

    const id = `demo-${Date.now()}`;

    saveProject({
      id,
      name: 'Исправить форму на WordPress',
      description:
        'После обновления плагинов перестала ' +
        'отправляться форма заявки. ' +
        'Нужно найти причину и исправить.',
      priceLimit: '5000',
      category_id: '38',
      date_create: new Date().toISOString()
    });

    return ctx.reply(
      'Тестовый проект\n\n' +
      'Исправить форму на WordPress\n' +
      'Бюджет: 5 000 ₽\n\n' +
      'После обновления плагинов перестала ' +
      'работать форма.',

      Markup.inlineKeyboard([
        [
          button('Текст ответа', `reply:${id}`)
        ],
        [
          button('Главное меню', 'nav:home')
        ]
      ])
    );
  });
}

module.exports = { registerNavigation };
