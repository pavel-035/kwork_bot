
const fs = require('fs');

const html = fs.readFileSync(
  'kwork-response.html',
  'utf8'
);

// Находим присваивание stateData
const match = /(?:window\.)?stateData\s*=\s*/.exec(html);

if (!match) {
  console.log('Присваивание stateData не найдено');
  process.exit(1);
}

let start = match.index + match[0].length;

while (/\s/.test(html[start])) start++;

if (html[start] !== '{' && html[start] !== '[') {
  console.log('Обнаружен другой формат stateData');
  console.log('Начало:', html.slice(start, start + 40));
  process.exit(1);
}

// Извлекаем JSON с учётом вложенных объектов
const stack = [];
let inString = false;
let escaped = false;
let end = -1;

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
      end = i + 1;
      break;
    }
  }
}

if (end === -1) {
  throw new Error('Не найден конец JSON');
}

const data = JSON.parse(html.slice(start, end));

console.log('\nКлючи stateData:');
console.log(Object.keys(data));

// Ищем массивы с проектами
function inspect(obj, path = 'stateData', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 7) {
    return;
  }

  if (Array.isArray(obj)) {
    if (obj.length && typeof obj[0] === 'object') {
      const keys = Object.keys(obj[0] || {});

      const hasTitle = keys.some(k =>
        /title|name|subject/i.test(k)
      );

      const hasId = keys.some(k =>
        /(^id$|_id$)/i.test(k)
      );

      if (hasTitle && hasId) {
        console.log('\nВозможный список проектов:');
        console.log('Путь:', path);
        console.log('Количество:', obj.length);
        console.log('Поля:', keys);
      }
    }

    obj.slice(0, 2).forEach((item, i) => {
      inspect(item, `${path}[${i}]`, depth + 1);
    });

    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    inspect(value, `${path}.${key}`, depth + 1);
  }
}


const projects = data.wantsListData.pagination.data;

// Собираем названия категорий
const categoryMap = new Map();

for (const group of Object.values(data.categories || {})) {
  if (!group || typeof group !== 'object') continue;

  if (group.name && (group.id || group.CATID)) {
    categoryMap.set(
      String(group.id ?? group.CATID),
      group.name
    );
  }

  for (const category of group.cats || []) {
    categoryMap.set(
      String(category.id ?? category.CATID),
      category.name
    );
  }
}

console.log('\nВсего проектов:', projects.length);

console.table(
  projects.slice(0, 8).map(p => ({
    id: p.id,
    name: p.name,
    category_id: p.category_id,
    category: categoryMap.get(String(p.category_id)) || 'Не найдена',
    budget: JSON.stringify(p.priceLimit ?? null),
    date_create: p.date_create,
    date_active: p.date_active
  }))
);

// Проверяем избранные категории
console.log('\nИзбранные категории:');
console.dir(data.favouriteCategories, { depth: 3 });

// Проверяем текущий режим списка
console.log('\nНастройки выдачи:');
console.log({
  isWantsOnly: data.isWantsOnly,
  urlParametersView: data.urlParametersView
});



console.log('\n=== Категории для мониторинга ===');

const targetNames = [
  'Доработка и настройка сайта',
  'Создание сайтов',
  'Верстка',
  'Вёрстка',
  'Сервера и хостинг',
  'Скрипты, боты и mini apps',
  'Юзабилити, тесты и помощь'
];

const selectedCategories = [...categoryMap.entries()]
  .filter(([id, name]) =>
    targetNames.some(
      target =>
        name.toLowerCase() === target.toLowerCase()
    )
  )
  .map(([id, name]) => ({
    id,
    name,
    url: `https://kwork.ru/projects?c=${id}`
  }));

console.table(selectedCategories);


console.log('\n=== Категории создания сайтов ===');

console.table(
  [...categoryMap.entries()]
    .filter(([id, name]) =>
      /создан.*сайт|разработ.*сайт/i.test(name)
    )
    .map(([id, name]) => ({
      id,
      name,
      url: `https://kwork.ru/projects?c=${id}`
    }))
);


console.log('\n=== Структура подкатегорий ===');

const attrs = data.attributes;

console.log('Тип:', Array.isArray(attrs) ? 'Массив' : typeof attrs);

console.log(
  'Ключи:',
  Object.keys(attrs || {}).slice(0, 30)
);

const sample = Array.isArray(attrs)
  ? attrs.slice(0, 3)
  : Object.fromEntries(
    Object.entries(attrs || {}).slice(0, 3)
  );

console.dir(sample, {
  depth: 5,
  maxArrayLength: 15
});


console.log('\n=== ПОЛНЫЙ КАТАЛОГ KWORK ===');

const groups = data.categoriesWithFavoritesList || data.categories || {};

const catalog = Object.entries(groups)
  .filter(([id, group]) => group && Array.isArray(group.cats))
  .map(([id, group]) => ({
    id: String(group.id ?? group.CATID ?? id),
    name: group.name || group.title || data.categories?.[id]?.name || `Раздел ${id}`,

    categories: group.cats.map(cat => ({
      id: String(cat.id ?? cat.CATID),
      name: cat.name,
      attributes: cat.attributes || null
    }))
  }));

// Сохраняем весь полученный каталог
fs.writeFileSync(
  'kwork-catalog.json',
  JSON.stringify(catalog, null, 2),
  'utf8'
);

// Выводим разделы и количество категорий
console.table(
  catalog.map(group => ({
    id: group.id,
    name: group.name,
    categories: group.categories.length
  }))
);

const allCategories = catalog.flatMap(group => group.categories);

console.log('Всего разделов:', catalog.length);
console.log('Всего категорий:', allCategories.length);

// Проверяем структуру подкатегорий
const withAttributes = allCategories.filter(cat =>
  cat.attributes &&
  Object.keys(cat.attributes).length > 0
);

console.log(
  'Категорий с атрибутами:',
  withAttributes.length
);

console.log('\n=== ПРИМЕР АТРИБУТОВ КАТЕГОРИИ ===');

if (withAttributes.length > 0) {
  console.dir(withAttributes[0], {
    depth: 5,
    maxArrayLength: 10
  });
} else {
  console.log('Атрибуты внутри категорий не найдены');
}

console.log('\n=== ОБЩИЕ АТРИБУТЫ ===');

console.log(
  'Тип:',
  Array.isArray(data.attributes) ? 'Массив' : typeof data.attributes
);

console.log(
  'Ключи:',
  Object.keys(data.attributes || {}).slice(0, 20)
);

console.log('\nКаталог сохранён в kwork-catalog.json');
