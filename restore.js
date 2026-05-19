'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crontab = require('./crontab');

exports.crontabs = (dbName, callback) => {
  const dbFile = path.join(crontab.db_folder, dbName);
  if (!fs.existsSync(dbFile)) {
    callback([]);
    return;
  }

  let backupDb;
  try {
    backupDb = new Database(dbFile, { readonly: true });
    const docs = backupDb.prepare('SELECT * FROM jobs ORDER BY created DESC').all();
    docs.forEach((doc) => {
      doc.stopped = doc.stopped === 1;
      doc.saved = doc.saved === 1;
      if (doc.mailing && typeof doc.mailing === 'string') {
        try {
          doc.mailing = JSON.parse(doc.mailing);
        } catch (_e) {
          doc.mailing = {};
        }
      }
    });
    callback(docs);
  } catch (err) {
    console.error(err);
    callback([]);
  } finally {
    if (backupDb) {
      backupDb.close();
    }
  }
};

exports.delete = (dbName) => {
  fs.unlink(path.join(crontab.db_folder, dbName), (err) => {
    if (err) throw err;
    console.log('Backup deleted');
  });
};
