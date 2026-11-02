
require('dotenv').config();

const OpenAI = require('openai');
const fetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY не указан в .env');
}

const agent = process.env.TELEGRAM_PROXY_URL
  ? new SocksProxyAgent(process.env.TELEGRAM_PROXY_URL)
  : undefined;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,

  // Используем прокси SnowVPN
  fetch: (url, options) =>
    fetch(url, { ...options, agent }),

  timeout: 30000,
  maxRetries: 1
});

async function test() {
  console.log('Отправляем запрос в OpenAI...');

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-6-luna',
      store: false,
      instructions: `
Ты помощник веб-разработчика с опытом более 3 лет.

Навыки: WordPress, Elementor, ACF, Tilda,
HTML, CSS, JavaScript, PHP, Vue.js, Nuxt,
настройка хостинга, доменов и SSL.

Составляй короткие, естественные отклики
на проекты фриланс-биржи Kwork.

Правила:
- Пиши на русском языке.
- Без воды и рекламных клише.
- Не выдумывай опыт и выполненные проекты.
- Не обещай сроки и цены без оценки задачи.
- Не предлагай SEO как отдельную услугу.
- Если информации не хватает, задай один
  конкретный вопрос заказчику.
- Длина отклика: 400–600 символов.
      `,
      input: `
Проект Kwork:
Название: Развернуть сайт на хостинге

Описание:
Есть готовый сайт. Нужно перенести его
на хостинг, подключить домен и SSL.

Составь отклик на этот проект.
      `
    });

    console.log('\n=== ОТКЛИК GPT ===\n');
    console.log(response.output_text);

    console.log('\nИспользовано токенов:');
    console.log(response.usage?.total_tokens);

  } catch (error) {
    console.error(
      'Ошибка OpenAI:',
      error.status || '',
      error.message
    );
  }
}

test();

