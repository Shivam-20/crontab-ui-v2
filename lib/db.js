'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbFolder = process.env.CRON_DB_PATH || path.join(__dirname, '..', 'crontabs');
const crontabDbFile = path.join(dbFolder, 'crontab.db');
const backupsDbFile = path.join(dbFolder, 'backups.db');

// Ensure directory exists
if (!fs.existsSync(dbFolder)) {
  fs.mkdirSync(dbFolder, { recursive: true });
}

// Initialize database connections
let db = null;
let backupsDb = null;

function getDb() {
  if (!fs.existsSync(dbFolder)) {
    fs.mkdirSync(dbFolder, { recursive: true });
  }
  if (!db) {
    db = new Database(crontabDbFile);
    db.pragma('journal_mode = WAL');
    initializeTables();
    migrateBackupsFromCrontabDb();
  }
  return db;
}

function getBackupsDb() {
  if (!fs.existsSync(dbFolder)) {
    fs.mkdirSync(dbFolder, { recursive: true });
  }
  if (!backupsDb) {
    backupsDb = new Database(backupsDbFile);
    backupsDb.pragma('journal_mode = WAL');
    initializeBackupsTable();
  }
  return backupsDb;
}

function normalizeQueryValue(key, value) {
  if (key === 'stopped' || key === 'saved') {
    return value ? 1 : 0;
  }
  return value;
}

function normalizeWriteValue(key, value) {
  if (key === 'mailing') {
    if (value && typeof value === 'object') {
      return JSON.stringify(value);
    }
    return value || '{}';
  }
  if (key === 'stopped' || key === 'saved') {
    return value ? 1 : 0;
  }
  if (key === 'minimal') {
    return value === true || value === 'true' ? 'true' : 'false';
  }
  if (key === 'disableMethod') {
    return value || 'remove';
  }
  return value;
}

function parseMailing(mailing) {
  if (!mailing || typeof mailing !== 'string') {
    return mailing || {};
  }
  try {
    return JSON.parse(mailing);
  } catch (_e) {
    return {};
  }
}

function normalizeJobDoc(doc) {
  doc.stopped = doc.stopped === 1;
  doc.saved = doc.saved === 1;
  if (doc.mailing && typeof doc.mailing === 'string') {
    doc.mailing = parseMailing(doc.mailing);
  }
  return doc;
}

function initializeTables() {
  const database = getDb();

  // Jobs table
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      _id TEXT PRIMARY KEY,
      name TEXT,
      command TEXT NOT NULL,
      schedule TEXT NOT NULL,
      stopped INTEGER DEFAULT 0,
      timestamp TEXT,
      logging TEXT,
      mailing TEXT,
      minimal TEXT DEFAULT 'false',
      disableMethod TEXT DEFAULT 'remove',
      created INTEGER,
      saved INTEGER DEFAULT 0,
      hook TEXT
    )
  `);

  // Logs table (for storing stderr/stdout logs)
  database.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      createdAt INTEGER,
      FOREIGN KEY (jobId) REFERENCES jobs(_id) ON DELETE CASCADE
    )
  `);
}

function initializeBackupsTable() {
  const database = getBackupsDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS backups (
      _id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data BLOB NOT NULL,
      createdAt INTEGER
    )
  `);
}

function migrateBackupsFromCrontabDb() {
  const database = getDb();
  const table = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='backups'"
  ).get();
  if (!table) {
    return;
  }

  const rows = database.prepare('SELECT _id, name, data, createdAt FROM backups').all();
  if (rows.length > 0) {
    const backupsDatabase = getBackupsDb();
    const insert = backupsDatabase.prepare(
      'INSERT OR IGNORE INTO backups (_id, name, data, createdAt) VALUES (?, ?, ?, ?)'
    );
    const insertMany = backupsDatabase.transaction((items) => {
      for (const row of items) {
        insert.run(row._id, row.name, row.data, row.createdAt);
      }
    });
    insertMany(rows);
  }

  database.exec('DROP TABLE IF EXISTS backups');
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function closeDb() {
  if (db) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (_e) {
      // ignore checkpoint errors during shutdown
    }
    db.close();
    db = null;
  }
}

function closeBackupsDb() {
  if (backupsDb) {
    try {
      backupsDb.pragma('wal_checkpoint(TRUNCATE)');
    } catch (_e) {
      // ignore checkpoint errors during shutdown
    }
    backupsDb.close();
    backupsDb = null;
  }
}

function removeSqliteSidecars(dbFile) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.unlinkSync(dbFile + suffix);
    } catch (_e) {
      // ignore missing sidecars
    }
  }
}

module.exports = {
  db_folder: dbFolder,
  crontab_db_file: crontabDbFile,
  backups_db_file: backupsDbFile,

  insert: (data) => {
    const database = getDb();
    const _id = data._id || generateId();
    const stmt = database.prepare(`
      INSERT INTO jobs (_id, name, command, schedule, stopped, timestamp, logging, mailing, minimal, disableMethod, created, saved, hook)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      _id,
      data.name || null,
      data.command,
      data.schedule,
      data.stopped ? 1 : 0,
      data.timestamp,
      data.logging || null,
      normalizeWriteValue('mailing', data.mailing),
      normalizeWriteValue('minimal', data.minimal),
      normalizeWriteValue('disableMethod', data.disableMethod),
      data.created || Date.now(),
      data.saved ? 1 : 0,
      data.hook || null
    );

    return _id;
  },

  update: (query, updateObj) => {
    const database = getDb();

    // Prepare update values
    const setFields = [];
    const values = [];

    if (updateObj.$set) {
      // Handle { $set: { field: value } } format (nedb style)
      Object.entries(updateObj.$set).forEach(([key, value]) => {
        setFields.push(`${key} = ?`);
        values.push(normalizeWriteValue(key, value));
      });
    } else {
      // Handle direct field updates (full object)
      Object.entries(updateObj).forEach(([key, value]) => {
        if (key !== '_id') {
          setFields.push(`${key} = ?`);
          values.push(normalizeWriteValue(key, value));
        }
      });
    }

    if (setFields.length === 0) return;

    if (query && query._id) {
      values.push(query._id);
      const stmt = database.prepare(`UPDATE jobs SET ${setFields.join(', ')} WHERE _id = ?`);
      stmt.run(...values);
      return;
    }

    // NeDB-style update({}, {$set: ...}) should apply to all rows.
    const stmt = database.prepare(`UPDATE jobs SET ${setFields.join(', ')}`);
    stmt.run(...values);
  },

  find: (query) => {
    return {
      sort: (sortObj) => {
        return {
          exec: (callback) => {
            try {
              const database = getDb();
              const sortField = Object.keys(sortObj)[0];
              const sortOrder = sortObj[sortField] === -1 ? 'DESC' : 'ASC';

              let sql = 'SELECT * FROM jobs';
              const params = [];

              // Build WHERE clause if query has conditions
              if (Object.keys(query).length > 0) {
                const whereConditions = [];
                Object.entries(query).forEach(([key, value]) => {
                  whereConditions.push(`${key} = ?`);
                  params.push(normalizeQueryValue(key, value));
                });
                sql += ` WHERE ${whereConditions.join(' AND ')}`;
              }

              sql += ` ORDER BY ${sortField} ${sortOrder}`;

              const stmt = database.prepare(sql);
              const docs = stmt.all(...params);

              docs.forEach(normalizeJobDoc);

              callback(null, docs);
            } catch (err) {
              callback(err, null);
            }
          },
        };
      },
      exec: (callback) => {
        try {
          const database = getDb();
          let sql = 'SELECT * FROM jobs';
          const params = [];

          if (Object.keys(query).length > 0) {
            const whereConditions = [];
            Object.entries(query).forEach(([key, value]) => {
              whereConditions.push(`${key} = ?`);
              params.push(normalizeQueryValue(key, value));
            });
            sql += ` WHERE ${whereConditions.join(' AND ')}`;
          }

          const stmt = database.prepare(sql);
          const docs = stmt.all(...params);

          docs.forEach(normalizeJobDoc);

          callback(null, docs);
        } catch (err) {
          callback(err, null);
        }
      },
    };
  },

  remove: (query, _opts) => {
    const database = getDb();
    const stmt = database.prepare('DELETE FROM jobs WHERE _id = ?');
    stmt.run(query._id);
  },

  findOne: (query, callback) => {
    try {
      const database = getDb();
      let sql = 'SELECT * FROM jobs WHERE';
      const params = [];
      const conditions = [];

      Object.entries(query).forEach(([key, value]) => {
        conditions.push(`${key} = ?`);
        params.push(normalizeQueryValue(key, value));
      });

      sql += ` ${conditions.join(' AND ')} LIMIT 1`;

      const stmt = database.prepare(sql);
      const doc = stmt.get(...params);

      if (doc) {
        normalizeJobDoc(doc);
      }

      callback(null, doc || null);
    } catch (err) {
      callback(err, null);
    }
  },

  // Log storage methods
  addLog: (jobId, type, content) => {
    const database = getDb();
    const stmt = database.prepare(`
      INSERT INTO logs (jobId, type, content, createdAt)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(jobId, type, content, Date.now());
  },

  getLogs: (jobId) => {
    const database = getDb();
    const stmt = database.prepare('SELECT * FROM logs WHERE jobId = ? ORDER BY createdAt DESC');
    return stmt.all(jobId);
  },

  // Flush WAL so a raw file read of crontab.db is consistent
  checkpoint: () => {
    const database = getDb();
    database.pragma('wal_checkpoint(TRUNCATE)');
  },

  // Consistent on-disk snapshot of crontab.db (jobs/logs only; backups live elsewhere)
  snapshotCrontabSync: () => {
    const database = getDb();
    const tempFile = path.join(dbFolder, `.snap-${Date.now()}-${process.pid}.db`);
    try {
      // VACUUM INTO copies the committed database from the open connection
      database.exec(`VACUUM INTO '${tempFile.replace(/'/g, "''")}'`);
      return fs.readFileSync(tempFile);
    } finally {
      try {
        fs.unlinkSync(tempFile);
      } catch (_e) {
        // ignore cleanup errors
      }
    }
  },

  // Backup methods (stored in separate backups.db to avoid nested BLOB growth)
  saveBackup: (backupName, backupData) => {
    const database = getBackupsDb();
    const _id = generateId();
    const stmt = database.prepare(`
      INSERT INTO backups (_id, name, data, createdAt)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(_id, backupName, backupData, Date.now());
    return _id;
  },

  getBackups: () => {
    const database = getBackupsDb();
    const stmt = database.prepare('SELECT name, _id, createdAt FROM backups ORDER BY createdAt DESC');
    return stmt.all();
  },

  restoreBackup: (backupId) => {
    const database = getBackupsDb();
    const stmt = database.prepare('SELECT data FROM backups WHERE _id = ?');
    const result = stmt.get(backupId);
    return result ? result.data : null;
  },

  deleteBackup: (backupId) => {
    const database = getBackupsDb();
    const stmt = database.prepare('DELETE FROM backups WHERE _id = ?');
    stmt.run(backupId);
  },

  close: () => {
    closeDb();
    closeBackupsDb();
  },

  // Reinitialize database
  reload: () => {
    closeDb();
    getDb();
  },

  removeSqliteSidecars,
};
