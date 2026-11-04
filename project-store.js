
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'project-drafts.json');

function readData() {
  if (!fs.existsSync(FILE)) return {};
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

function writeData(data) {
  const temp = FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, FILE);
}

function saveProject(project) {
  const db = readData();
  const id = String(project.id);
  const old = db[id] || {};

  db[id] = {
    ...old,
    project: {
      id,
      name: String(project.name || ''),
      description: String(project.description || '')
        .slice(0, 10000),
      priceLimit: project.priceLimit,
      date_create: project.date_create,
      category_id: String(project.category_id || ''),
      username: String(
        project.username ??
        project.user_name ??
        project.user?.username ??
        ''
      ).trim(),
    },
    receivedAt: old.receivedAt ||
      new Date().toISOString()
  };

  writeData(db);
}

function getProject(id) {
  return readData()[String(id)]?.project || null;
}

function getDraft(id) {
  return readData()[String(id)]?.draft || null;
}

function saveDraft(id, text) {
  const db = readData();
  const entry = db[String(id)];

  if (!entry) throw new Error('Проект не сохранён');

  const old = entry.draft;

  if (old && old !== text) {
    entry.history = [
      ...(entry.history || []),
      old
    ].slice(-20);
  }

  entry.draft = text;
  writeData(db);
}

function getDraftHistory(id) {
  return readData()[String(id)]?.history || [];
}

function restoreDraft(id, index) {
  const history = getDraftHistory(id);

  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= history.length
  ) {
    throw new Error('Версия не найдена');
  }

  saveDraft(id, history[index]);
  return history[index];
}

function listProjects(mode = 'all') {
  return Object.entries(readData())
    .filter(([, item]) => item && item.project)
    .filter(([, item]) => {
      if (mode === 'drafts') {
        return !!item.draft && !item.hidden;
      }
      if (mode === 'unread') {
        return !item.read && !item.hidden;
      }
      if (mode === 'hidden') {
        return !!item.hidden;
      }
      return !item.hidden;
    })
    .map(([id, item]) => ({
      id,
      ...item.project,
      read: !!item.read,
      hidden: !!item.hidden,
      hasDraft: !!item.draft,
      receivedAt: item.receivedAt
    }))
    .sort((a, b) =>
      String(b.date_create || b.receivedAt || '')
        .localeCompare(
          String(a.date_create || a.receivedAt || '')
        )
    );
}

function updateFlags(id, patch) {
  const db = readData();

  if (!db[String(id)]) return false;

  Object.assign(db[String(id)], patch);
  writeData(db);

  return true;
}

function markRead(id) {
  return updateFlags(id, { read: true });
}

function setHidden(id, hidden) {
  return updateFlags(id, { hidden: !!hidden });
}

function getCounts() {
  const db = Object.values(readData())
    .filter(item => item?.project);

  return {
    all: db.filter(item => !item.hidden).length,
    unread: db.filter(item =>
      !item.hidden && !item.read
    ).length,
    drafts: db.filter(item =>
      !item.hidden && item.draft
    ).length,
    hidden: db.filter(item => item.hidden).length
  };
}


function saveOffer(id, offer) {
  const db = readData();
  const entry = db[String(id)];

  if (!entry) {
    throw new Error('Проект не найден');
  }

  entry.offer = {
    priceRub: offer.priceRub,
    term: offer.term
  };

  writeData(db);
}

function getOffer(id) {
  return readData()[String(id)]?.offer || null;
}

module.exports = {
  saveProject,
  getProject,
  getDraft,
  saveDraft,
  getDraftHistory,
  restoreDraft,
  listProjects,
  markRead,
  setHidden,
  getCounts,
  saveOffer,
  getOffer
};
