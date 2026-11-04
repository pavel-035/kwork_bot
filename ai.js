const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');

const agent = process.env.TELEGRAM_PROXY_URL
  ? new SocksProxyAgent(process.env.TELEGRAM_PROXY_URL)
  : undefined;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  fetch: (url, options) =>
    fetch(url, { ...options, agent }),
  timeout: 30000,
  maxRetries: 1
});

const instructions = require('./prompt');


const PROMPT_FILE = path.join(__dirname, 'ai-prompt.txt');

// Получаем текущий промпт
function getAiPrompt() {
  return instructions;
}

// Сохраняем новый промпт
function saveAiPrompt(text) {
  const prompt = String(text).trim();

  if (!prompt.length) {
    throw new Error('Промпт не может быть пустым');
  }

  fs.writeFileSync(PROMPT_FILE, prompt, 'utf8');
}


async function requestAI(input) {
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-6-luna',
    store: false,
    instructions: getAiPrompt(),
    input: JSON.stringify(input),
    max_output_tokens: 850
  });

  const text = response.output_text?.trim();

  if (!text) {
    throw new Error('GPT вернул пустой ответ');
  }

  return text;
}

function compactProject(project) {
  return {
    title: project.name,
    description: String(project.description || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000),
    budget: project.priceLimit
  };
}


// Генерация первоначального отклика
function generateReply(project, offer) {
  return requestAI({
    task: `
Составь персональный отклик на заказ Kwork.

Исполнитель самостоятельно установил стоимость
и срок выполнения. Обязательно укажи их в отклике.

Не изменяй стоимость и срок.
Не путай бюджет заказчика с ценой исполнителя.
Не придумывай дополнительных условий.
    `,
    project: compactProject(project),
    customerUsername: project.username || null,
    executorOffer: {
      priceRub: offer.priceRub,
      completionTerm: offer.term
    }
  });
}

// Редактирование отклика
function reviseReply(project, previousDraft, userChanges, offer) {
  return requestAI({
    task: `
Измени предыдущий отклик согласно правкам пользователя.

Сохраняй указанную исполнителем стоимость
и срок выполнения, если пользователь явно
не попросил их изменить.

Верни только готовый исправленный отклик.
    `,
    project: compactProject(project),
    customerUsername: project.username || null,
    executorOffer: offer,
    previousDraft,
    userChanges
  });
}

module.exports = {
  generateReply,
  reviseReply,
  getAiPrompt,
  saveAiPrompt
};
