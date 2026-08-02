'use strict';

const db = require('./lib/db');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const { CronExpressionParser } = require('cron-parser');
const cronstrue = require('cronstrue/i18n');

const humanCronLocale = process.env.HUMANCRON ?? 'en';

const dbFolder = db.db_folder;
console.log(`Cron db path: ${dbFolder}`);

const logFolder = path.join(dbFolder, 'logs');
const envFile = path.join(dbFolder, 'env.db');
const crontabDbFile = db.crontab_db_file;

let cronPath = '/tmp';
if (process.env.CRON_PATH !== undefined) {
  console.log(`Path to crond files set using env variables ${process.env.CRON_PATH}`);
  cronPath = process.env.CRON_PATH;
}

if (!fs.existsSync(logFolder)) {
  fs.mkdirSync(logFolder, { recursive: true });
}

function buildCrontab(name, command, schedule, stopped, logging, mailing, minimal, disableMethod) {
  return {
    name,
    command,
    schedule,
    ...(stopped !== null && { stopped }),
    timestamp: new Date().toString(),
    logging,
    mailing: mailing || {},
    minimal: minimal || 'false',
    disableMethod: disableMethod || 'remove',
  };
}

function makeCommand(tab) {
  // If minimal flag is set, return plain command without output capture
  if (tab.minimal === 'true' || tab.minimal === true) {
    return tab.command;
  }

  const stderr = path.join(cronPath, `${tab._id}.stderr`);
  const stdout = path.join(cronPath, `${tab._id}.stdout`);
  const logFile = path.join(logFolder, `${tab._id}.log`);
  const logFileStdout = path.join(logFolder, `${tab._id}.stdout.log`);

  let cmd = tab.command;
  if (cmd[cmd.length - 1] !== ';') {
    cmd += ';';
  }

  let result = `({ ${cmd} } | tee ${stdout})`;
  result = `(${result} 3>&1 1>&2 2>&3 | tee ${stderr}) 3>&1 1>&2 2>&3`;
  result = `(${result})`;

  if (tab.logging && tab.logging === 'true') {
    result += `; if test -f ${stderr}; then date >> "${logFile}"; cat ${stderr} >> "${logFile}"; fi`;
    result += `; if test -f ${stdout}; then date >> "${logFileStdout}"; cat ${stdout} >> "${logFileStdout}"; fi`;
  }

  if (tab.hook) {
    result += `; if test -f ${stdout}; then ${tab.hook} < ${stdout}; fi`;
  }

  if (tab.mailing && JSON.stringify(tab.mailing) !== '{}') {
    result += `; ${JSON.stringify(process.execPath)} ${__dirname}/bin/crontab-ui-mailer.js ${tab._id} ${stdout} ${stderr}`;
  }

  return result;
}

function addEnvVars(envVars, command) {
  if (envVars) {
    return `(${envVars.replace(/\s*\n\s*/g, ' ').trim()}; (${command}))`;
  }
  return command;
}

exports.db_folder = dbFolder;
exports.log_folder = logFolder;
exports.env_file = envFile;
exports.crontab_db_file = crontabDbFile;

exports.create_new = (name, command, schedule, logging, mailing, minimal, disableMethod) => {
  const tab = buildCrontab(name, command, schedule, false, logging, mailing, minimal, disableMethod);
  tab.created = Date.now();
  tab.saved = false;
  db.insert(tab);
};

exports.update = (data) => {
  const tab = buildCrontab(data.name, data.command, data.schedule, null, data.logging, data.mailing, data.minimal, data.disableMethod);
  tab.saved = false;
  db.update({ _id: data._id }, tab);
};

exports.status = (_id, stopped, disableMethod) => {
  const patch = { stopped, saved: false };
  if (disableMethod) {
    patch.disableMethod = disableMethod;
  }
  db.update({ _id }, { $set: patch });
};

exports.remove = (_id) => {
  db.remove({ _id }, {});
};

exports.crontabs = (callback, hasRetried = false) => {
  db.find({}).sort({ created: -1 }).exec((err, docs) => {
    if (err) {
      console.error(err);
      if (!hasRetried) {
        db.reload();
        return exports.crontabs(callback, true);
      }
      return callback([]);
    }
    for (const doc of docs) {
      if (doc.schedule === '@reboot') {
        doc.next = 'Next Reboot';
      } else {
        try {
          doc.human = cronstrue.toString(doc.schedule, { locale: humanCronLocale });
          doc.next = CronExpressionParser.parse(doc.schedule).next().toString();
        } catch (e) {
          console.error(e);
          doc.next = 'invalid';
        }
      }
    }
    callback(docs);
  });
};

exports.get_crontab = (_id, callback) => {
  db.find({ _id }).exec((err, docs) => {
    callback(docs && docs.length > 0 ? docs[0] : null);
  });
};

exports.runjob = (_id) => {
  exports.get_crontab(_id, (res) => {
    if (!res) return;
    const envVars = exports.get_env();
    let cmd = makeCommand(res);
    cmd = addEnvVars(envVars, cmd);

    console.log('Running job');
    console.log(`ID: ${_id}`);
    console.log(`Original command: ${res.command}`);
    console.log(`Executed command: ${cmd}`);

    exec(cmd, (error) => {
      if (error) console.log(error);
    });
  });
};

exports.set_crontab = (envVars, callback) => {
  exports.crontabs((tabs) => {
    let crontabString = '';
    if (envVars) {
      crontabString += `${envVars}\n`;
    }
    for (const tab of tabs) {
      const cmd = makeCommand(tab);
      const line = `${tab.schedule} ${cmd}\n`;
      
      if (tab.stopped) {
        // Handle disabled jobs based on disableMethod
        if (tab.disableMethod === 'comment') {
          crontabString += `# ${line}`;
        }
        // If disableMethod is 'remove' or undefined, skip the line (current behavior)
      } else {
        crontabString += line;
      }
    }

    fs.writeFile(envFile, envVars, (err) => {
      if (err) {
        console.error(err);
        return callback(err);
      }
      const fileName = process.env.CRON_IN_DOCKER !== undefined ? 'root' : 'crontab';
      fs.writeFile(path.join(cronPath, fileName), crontabString, (err) => {
        if (err) {
          console.error(err);
          return callback(err);
        }
        exec(`crontab ${path.join(cronPath, fileName)}`, (err) => {
          if (err) {
            console.error(err);
            return callback(err);
          }
          db.update({}, { $set: { saved: true } });
          callback();
        });
      });
    });
  });
};

exports.get_backups = () => {
  return db.getBackups();
};

exports.backup = (callback) => {
  const backupName = `backup ${new Date().toString().replace('+', ' ')}.db`;
  try {
    const data = db.snapshotCrontabSync();
    db.saveBackup(backupName, data);
    callback();
  } catch (err) {
    console.error(err);
    callback(err);
  }
};

exports.backup_file = (callback) => {
  const dest = path.join(dbFolder, `backup ${new Date().toString().replace('+', ' ')}.db`);
  fs.copyFile(crontabDbFile, dest, (err) => {
    if (err) {
      console.error(err);
      return callback(err);
    }
    callback();
  });
};

exports.restore = (backupId) => {
  const data = db.restoreBackup(backupId);
  if (data) {
    db.close();
    db.removeSqliteSidecars(crontabDbFile);
    fs.writeFileSync(crontabDbFile, data);
    db.reload();
  }
};

exports.reload_db = () => {
  db.reload();
};

exports.close_db = () => {
  db.close();
};

exports.get_env = () => {
  if (fs.existsSync(envFile)) {
    return fs.readFileSync(envFile, 'utf8').replace('\n', '\n');
  }
  return '';
};

exports.import_crontab = (callback) => {
  exec('crontab -l', (error, stdout) => {
    if (error) {
      if (callback) callback();
      return;
    }

    const lines = stdout.split('\n');
    const namePrefix = Date.now();
    let pending = 0;

    const maybeDone = () => {
      if (pending === 0 && callback) {
        callback();
      }
    };

    lines.forEach((line, index) => {
      line = line.replace(/\t+/g, ' ');
      const regex = /^((@[a-zA-Z]+\s+)|(([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+))/;
      const command = line.replace(regex, '').trim();
      const schedule = line.replace(command, '').trim();

      let isValid = false;
      try {
        isValid = CronExpressionParser.parse(schedule) !== null;
      } catch (_e) { /* ignore */ }

      if (command && schedule && isValid) {
        pending += 1;
        const name = `${namePrefix}_${index}`;
        db.findOne({ command, schedule }, (err, doc) => {
          if (err) {
            console.error(err);
          } else if (!doc) {
            exports.create_new(name, command, schedule, null);
          } else {
            doc.command = command;
            doc.schedule = schedule;
            exports.update(doc);
          }
          pending -= 1;
          maybeDone();
        });
      }
    });

    maybeDone();
  });
};

exports.preview_crontab = (envVars, callback) => {
  exports.crontabs((tabs) => {
    let crontabString = '';
    if (envVars) {
      crontabString += `${envVars}\n`;
    }
    for (const tab of tabs) {
      const cmd = makeCommand(tab);
      const line = `${tab.schedule} ${cmd}\n`;
      
      if (tab.stopped) {
        if (tab.disableMethod === 'comment') {
          crontabString += `# ${line}`;
        }
      } else {
        crontabString += line;
      }
    }
    callback(crontabString);
  });
};

exports.autosave_crontab = (callback) => {
  const envVars = exports.get_env();
  exports.set_crontab(envVars, callback);
};
