'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crontab = require('./crontab');
const db = require('./lib/db');

exports.crontabs = (backupId, callback) => {
  const data = db.restoreBackup(backupId);
  if (!data) {
    callback([]);
    return;
  }

  // Write to temp file and read with better-sqlite3
  const tempFile = path.join(crontab.db_folder, `temp-${Date.now()}.db`);
  let backupDb;
  try {
    fs.writeFileSync(tempFile, data);
    backupDb = new Database(tempFile, { readonly: true });
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
    try {
      fs.unlinkSync(tempFile);
    } catch (_e) {
      // ignore cleanup errors
    }
  }
};

exports.delete = (backupId) => {
  db.deleteBackup(backupId);
  console.log('Backup deleted');
};
