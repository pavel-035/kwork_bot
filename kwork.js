
require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const { SocksProxyAgent } = require('socks-proxy-agent');

const URL = 'https://kwork.ru/projects';

async function getKworkProjects() {
  const agent = process.env.TELEGRAM_PROXY_URL
    ? new SocksProxyAgent(process.env.TELEGRAM_PROXY_URL)
    : undefined;

  try {
    console.log('Подключаемся к Kwork...');

    const response = await axios.get(URL, {
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
      timeout: 20000,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html'
      }
    });

    const html = response.data;

    console.log('HTTP статус:', response.status);
    console.log('Размер ответа:', html.length);
    console.log(
      'Найден stateData:',
      /stateData/.test(html)
    );

    fs.writeFileSync(
      'kwork-response.html',
      html,
      'utf8'
    );

    console.log('HTML сохранён в kwork-response.html');

  } catch (error) {
    console.error(
      'Ошибка:',
      error.response?.status || error.message
    );
  }
}

getKworkProjects();
