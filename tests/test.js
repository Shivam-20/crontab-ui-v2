'use strict';

/* global describe, it, expect, beforeAll, afterAll */
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const os = require('os');

const testDbPath = path.join(os.tmpdir(), `crontab-ui-test-${Date.now()}`);
fs.mkdirSync(testDbPath, { recursive: true });
fs.mkdirSync(path.join(testDbPath, 'logs'), { recursive: true });

process.env.CRON_DB_PATH = testDbPath;
process.env.CRON_PATH = testDbPath;
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const app = require('../app');

describe('Crontab UI', () => {
  afterAll(() => {
    fs.rmSync(testDbPath, { recursive: true, force: true });
  });

  describe('GET /', () => {
    it('should return the main page', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Crontab UI');
      expect(res.text).toContain('Cronjobs');
    });
  });

  describe('POST /save', () => {
    it('should create a new job', async () => {
      const res = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'test-job',
          command: 'echo hello',
          schedule: '* * * * *',
          logging: 'false',
          mailing: {},
        });
      expect(res.status).toBe(200);
    });

    it('should show the new job on the main page', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('test-job');
      expect(res.text).toContain('echo hello');
    });
  });

  describe('POST /stop and /start', () => {
    let jobId;

    beforeAll(async () => {
      const res = await request(app).get('/');
      const match = res.text.match(/stopJob\('([^']+)'\)/);
      jobId = match ? match[1] : null;
    });

    it('should stop a job', async () => {
      if (!jobId) return;
      const res = await request(app)
        .post('/stop')
        .send({ _id: jobId });
      expect(res.status).toBe(200);
    });

    it('should start a job', async () => {
      if (!jobId) return;
      const res = await request(app)
        .post('/start')
        .send({ _id: jobId });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /backup', () => {
    it('should create a backup', async () => {
      const res = await request(app).get('/backup');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /export', () => {
    it('should export the database', async () => {
      const res = await request(app).get('/export');
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('crontab.db');
    });
  });

  describe('POST /save (duplicate)', () => {
    it('should duplicate an existing job', async () => {
      const page = await request(app).get('/');
      const match = page.text.match(/duplicateJob\('([^']+)'\)/);
      const jobId = match ? match[1] : null;
      if (!jobId) return;

      const jobMatch = page.text.match(/test-job/);
      expect(jobMatch).not.toBeNull();

      const res = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'test-job (copy)',
          command: 'echo hello',
          schedule: '* * * * *',
          logging: 'false',
          mailing: {},
        });
      expect(res.status).toBe(200);

      const afterPage = await request(app).get('/');
      expect(afterPage.text).toContain('test-job (copy)');
    });
  });

  describe('GET /preview_crontab', () => {
    it('should return the crontab preview as plain text', async () => {
      const res = await request(app).get('/preview_crontab');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('echo hello');
    });

    it('should include the make_command wrapper (tee pipeline)', async () => {
      const res = await request(app).get('/preview_crontab');
      expect(res.text).toContain('tee');
      expect(res.text).toContain('stderr');
    });

    it('should only include active (non-stopped) jobs', async () => {
      const page = await request(app).get('/');
      const match = page.text.match(/stopJob\('([^']+)'\)/);
      if (!match) return;

      await request(app).post('/stop').send({ _id: match[1] });

      const res = await request(app).get('/preview_crontab');
      const lines = res.text.trim().split('\n').filter((l) => l.includes('echo hello'));
      const activePage = await request(app).get('/');
      const activeCount = (activePage.text.match(/stopJob\('/g) || []).length;
      expect(lines.length).toBe(activeCount);

      await request(app).post('/start').send({ _id: match[1] });
    });
  });

  describe('Input validation', () => {
    it('should reject path traversal in db param', async () => {
      const res = await request(app).get('/restore?id=../../etc/passwd');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid id parameter');
    });

    it('should reject invalid characters in id param', async () => {
      const res = await request(app).get('/logger?id=../../../etc/passwd');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid id parameter');
    });

    it('should allow valid id param', async () => {
      const res = await request(app).get('/restore?id=valid-id');
      expect(res.status).toBe(200);
    });

    it('should allow valid id param', async () => {
      const res = await request(app).get('/logger?id=abc123_test-id');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /remove', () => {
    let jobId;

    beforeAll(async () => {
      const res = await request(app).get('/');
      const match = res.text.match(/deleteJob\('([^']+)'\)/);
      jobId = match ? match[1] : null;
    });

    it('should remove a job', async () => {
      if (!jobId) return;
      const res = await request(app)
        .post('/remove')
        .send({ _id: jobId });
      expect(res.status).toBe(200);
    });

    it('should remove the duplicated job too', async () => {
      const page = await request(app).get('/');
      const match = page.text.match(/deleteJob\('([^']+)'\)/);
      if (!match) return;
      const res = await request(app)
        .post('/remove')
        .send({ _id: match[1] });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /logger', () => {
    it('should return no errors message when no log exists', async () => {
      const res = await request(app).get('/logger?id=nonexistent');
      expect(res.status).toBe(200);
      expect(res.text).toContain('No errors logged yet');
    });

    it('should return text/plain content type when no log exists', async () => {
      const res = await request(app).get('/logger?id=nonexistent');
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('should return text/plain and no-store when log file exists', async () => {
      const logFile = path.join(testDbPath, 'logs', 'testlog.log');
      fs.writeFileSync(logFile, 'some error output\n');
      const res = await request(app).get('/logger?id=testlog');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toContain('some error output');
      fs.unlinkSync(logFile);
    });
  });

  describe('GET /stdout', () => {
    it('should return no errors message when no log exists', async () => {
      const res = await request(app).get('/stdout?id=nonexistent');
      expect(res.status).toBe(200);
      expect(res.text).toContain('No errors logged yet');
    });

    it('should return text/plain content type when no log exists', async () => {
      const res = await request(app).get('/stdout?id=nonexistent');
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('should return text/plain and no-store when stdout log exists', async () => {
      const logFile = path.join(testDbPath, 'logs', 'teststdout.stdout.log');
      fs.writeFileSync(logFile, 'some stdout output\n');
      const res = await request(app).get('/stdout?id=teststdout');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toContain('some stdout output');
      fs.unlinkSync(logFile);
    });
  });

  describe('GET /import_crontab (auto-backup)', () => {
    it('should create a backup before importing', async () => {
      // ensure a job exists so crontab.db is non-empty
      await request(app).post('/save').send({
        _id: -1, name: 'backup-test', command: 'echo backup',
        schedule: '* * * * *', logging: 'false', mailing: {},
      });
      // small delay so backup filename (based on date) doesn't collide
      await new Promise((r) => setTimeout(r, 1100));
      const backupsBefore = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      await request(app).get('/import_crontab');
      const backupsAfter = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      expect(backupsAfter.length).toBe(backupsBefore.length + 1);
    });
  });

  describe('POST /import (auto-backup)', () => {
    it('should create a backup before importing a db file', async () => {
      // small delay so backup filename (based on date) doesn't collide
      await new Promise((r) => setTimeout(r, 1100));
      const backupsBefore = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      const dbContent = fs.readFileSync(path.join(testDbPath, 'crontab.db'));
      await request(app)
        .post('/import')
        .attach('file', dbContent, 'crontab.db');
      const backupsAfter = fs.readdirSync(testDbPath)
        .filter((f) => f.startsWith('backup'));
      expect(backupsAfter.length).toBe(backupsBefore.length + 1);
    });
  });

  describe('Command textarea', () => {
    it('should render a textarea for the command field', async () => {
      const res = await request(app).get('/');
      expect(res.text).toContain('<textarea');
      expect(res.text).toContain('id=\'job-command\'');
    });
  });
});
describe('Minimal crontab and disable methods', () => {
  describe('POST /save with minimal=true', () => {
    it('should create a job with minimal flag', async () => {
      const res = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'minimal-test',
          command: 'echo test',
          schedule: '*/5 * * * *',
          logging: 'false',
          mailing: {},
          minimal: true,
          disableMethod: 'remove',
        });
      expect(res.status).toBe(200);
    });

    it('should show minimal job without tee wrapper in preview', async () => {
      const res = await request(app).get('/preview_crontab');
      expect(res.status).toBe(200);
      // Minimal jobs should have plain command, not tee wrapper
      const lines = res.text.split('\n');
      const minimalLine = lines.find(l => l.includes('echo test'));
      expect(minimalLine).toBeDefined();
      // Should NOT contain tee or stderr for minimal job
      if (minimalLine) {
        expect(minimalLine).toMatch(/\*\/5 \* \* \* \* echo test/);
      }
    });
  });

  describe('Disable method: comment vs remove', () => {
    let commentJobId;
    let removeJobId;

    it('should create job with disableMethod=comment', async () => {
      const res = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'comment-disable-test',
          command: 'echo comment',
          schedule: '0 0 * * *',
          logging: 'false',
          mailing: {},
          minimal: false,
          disableMethod: 'comment',
        });
      expect(res.status).toBe(200);
    });

    it('should create job with disableMethod=remove', async () => {
      const res = await request(app)
        .post('/save')
        .send({
          _id: -1,
          name: 'remove-disable-test',
          command: 'echo remove',
          schedule: '0 1 * * *',
          logging: 'false',
          mailing: {},
          minimal: false,
          disableMethod: 'remove',
        });
      expect(res.status).toBe(200);
    });

    it('should show both jobs in preview before disabling', async () => {
      const page = await request(app).get('/');
      const commentMatch = page.text.match(/stopJob\('([^']+)'\)[^<]*?comment-disable-test/);
      const removeMatch = page.text.match(/stopJob\('([^']+)'\)[^<]*?remove-disable-test/);
      if (commentMatch) commentJobId = commentMatch[1];
      if (removeMatch) removeJobId = removeMatch[1];
    });

    it('should show commented line when job with disableMethod=comment is stopped', async () => {
      if (!commentJobId) return;
      await request(app)
        .post('/stop')
        .send({ _id: commentJobId, disableMethod: 'comment' });

      const res = await request(app).get('/preview_crontab');
      expect(res.text).toContain('# 0 0 * * *');
      expect(res.text).toContain('echo comment');
    });

    it('should NOT show line when job with disableMethod=remove is stopped', async () => {
      if (!removeJobId) return;
      await request(app)
        .post('/stop')
        .send({ _id: removeJobId, disableMethod: 'remove' });

      const res = await request(app).get('/preview_crontab');
      const lines = res.text.split('\n');
      const removeLine = lines.find(l => l.includes('echo remove') && !l.startsWith('#'));
      expect(removeLine).toBeUndefined();
    });

    it('should cleanup test jobs', async () => {
      const page = await request(app).get('/');
      const ids = [];
      const matches = page.text.match(/deleteJob\('([^']+)'\)/g);
      if (matches) {
        matches.forEach(m => {
          const id = m.match(/'([^']+)'/)[1];
          if (id && (id.includes('comment') || id.includes('remove') || id.includes('minimal'))) {
            ids.push(id);
          }
        });
      }

      for (const id of ids) {
        await request(app).post('/remove').send({ _id: id });
      }
    });
  });
});
describe('Routes module', () => {
  it('should export routes with base_url prefix', () => {
    const { routes, base_url } = require('../routes');
    expect(routes.root).toBe(base_url + '/');
    expect(routes.save).toBe(base_url + '/save');
    expect(routes.backup).toBe(base_url + '/backup');
  });

  it('should export relative routes', () => {
    const { relative } = require('../routes');
    expect(relative.save).toBe('save');
    expect(relative.backup).toBe('backup');
  });
});
