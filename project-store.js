
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'project-drafts.json');

const db = fs.existsSync(FILE)
  ? JSON.parse(fs.readFileSync(FILE, 'utf8'))
  : {};

function persist() {
  fs.writeFileSync(
    FILE,
    JSON.stringify(db, null, 2),
    'utf8'
  );
}

function saveProject(project) {
  const id = String(project.id);

  db[id] = {
    ...(db[id] || {}),
    project: {
      id,
      name: String(project.name || ''),
      description: String(project.description || '').slice(0, 10000),
      priceLimit: project.priceLimit,
      date_create: project.date_create,
      category_id: String(project.category_id || '')
    }
  };

  persist();
}

function getProject(id) {
  return db[String(id)]?.project || null;
}

function getDraft(id) {
  return db[String(id)]?.draft || null;
}

function saveDraft(id, text) {
  if (!db[String(id)]) {
    throw new Error('Проект не сохранён');
  }

  db[String(id)].draft = text;
  persist();
}

module.exports = {
  saveProject,
  getProject,
  getDraft,
  saveDraft
};
