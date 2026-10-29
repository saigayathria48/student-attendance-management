'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/security');

// Remote mode intentionally creates synthetic records and requires an isolated test deployment.
test('Chrome: create student, mark P1–P7, reload selected date, report and CSV', { timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-selenium-'));
  let db, server, driver;
  t.after(async () => {
    if (driver) await driver.quit();
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let base = process.env.BASE_URL;
  let username = process.env.TEST_USERNAME;
  let password = process.env.TEST_PASSWORD;
  if (base) {
    if (!username || !password) throw new Error('Remote BASE_URL requires TEST_USERNAME and TEST_PASSWORD for an administrator in an isolated test deployment.');
    base = base.replace(/\/$/, '');
  } else {
    username = `selenium-${crypto.randomBytes(6).toString('hex')}`;
    password = crypto.randomBytes(24).toString('base64url');
    db = openDatabase(path.join(dir, 'test.sqlite'));
    db.prepare('INSERT INTO users(username,password_hash,role) VALUES (?,?,?)').run(username, hashPassword(password), 'admin');
    server = createApp(db).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const options = new chrome.Options().addArguments('--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,1000');
  options.setUserPreferences({ 'download.default_directory': dir, 'download.prompt_for_download': false });
  driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  const capabilities = await driver.getCapabilities();
  let commit = 'unknown';
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  t.diagnostic(`Environment: node ${process.version} ${process.platform}; commit ${commit}; chrome ${capabilities.getBrowserVersion()}; started ${new Date().toISOString()}`);
  const find = css => driver.findElement(By.css(css));
  const click = async css => (await find(css)).click();
  const waitText = async (css, value) => driver.wait(async () => (await (await find(css)).getText()).includes(value), 10000, `Waiting for ${css} text: ${value}`);
  const setValue = async (css, value) => driver.executeScript('arguments[0].value=arguments[1]; arguments[0].dispatchEvent(new Event("change", {bubbles:true}));', await find(css), value);
  const type = async (css, value) => { const el = await find(css); await el.clear(); await el.sendKeys(value); };
  const submit = async css => (await find(css)).submit();
  const classLabel = `Selenium synthetic ${crypto.randomBytes(5).toString('hex')}`;
  const date = '2024-04-01';
  await driver.get(base);
  await driver.wait(until.elementLocated(By.css('#login-form input[name=username]')), 10000);
  await type('#login-form input[name=username]', username);
  await type('#login-form input[name=password]', password);
  await submit('#login-form');
  await driver.wait(async () => (await find('#app')).isDisplayed(), 10000, 'Sign in failed');
  await click('[data-view=admin]');
  await type('#class-form input[name=name]', classLabel);
  await submit('#class-form');
  await waitText('#notice', 'Class saved.');
  const classId = await driver.executeScript('return [...document.querySelectorAll("#student-form select[name=classId] option")].find(x => x.textContent === arguments[0]).value;', classLabel);
  await click('[data-view=students]');
  await setValue('#student-form select[name=classId]', classId);
  await type('#student-form input[name=roll]', 'S001');
  await type('#student-form input[name=name]', 'Synthetic Student');
  await type('#student-form input[name=department]', 'Test');
  await setValue('#student-form input[name=startDate]', date);
  await setValue('#student-form input[name=endDate]', date);
  await submit('#student-form');
  await waitText('#notice', 'Student saved.');
  assert.match(await (await find('#students-rows')).getText(), /S001\s+Synthetic Student/);
  await click('[data-view=attendance]');
  await setValue('#attendance-filter select[name=classId]', classId);
  await setValue('#attendance-filter input[name=date]', date);
  await submit('#attendance-filter');
  await waitText('#register-title', date);
  const controls = await driver.findElements(By.css('#attendance-rows select'));
  assert.equal(controls.length, 7, 'All seven eligible controls must be displayed');
  await click('[data-bulk=P]');
  // Exercise all three values on each eligible period before making exceptions.
  for (let period = 1; period <= 7; period++) {
    const selector = `#attendance-rows select[data-period="${period}"]`;
    for (const value of ['A', 'U', 'P']) {
      await setValue(selector, value);
      assert.equal(await (await find(selector)).getAttribute('value'), value);
    }
  }
  await setValue('#attendance-rows select[data-period="2"]', 'A');
  await setValue('#attendance-rows select[data-period="7"]', 'U');
  await submit('#attendance-save');
  await waitText('#attendance-state', 'Attendance saved and reloaded.');
  const statuses = async () => driver.executeScript('return [...document.querySelectorAll("#attendance-rows tr:first-child select")].map(x => x.value)');
  assert.deepEqual(await statuses(), ['P', 'A', 'P', 'P', 'P', 'P', 'U']);
  await click('#attendance-reload');
  await waitText('#attendance-state', 'Register loaded.');
  assert.deepEqual(await statuses(), ['P', 'A', 'P', 'P', 'P', 'P', 'U']);
  assert.equal(await (await find('#attendance-filter input[name=date]')).getAttribute('value'), date);
  // Simulate a second editor saving while this register is open.
  await setValue('#attendance-rows select[data-period="4"]', 'A');
  const concurrentStatus = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1], classId = arguments[0], day = arguments[1];
    (async () => {
      const session = await (await fetch('/api/session')).json();
      const register = await (await fetch('/api/attendance?classId=' + classId + '&date=' + day)).json();
      const response = await fetch('/api/attendance', {method:'PUT', headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken}, body:JSON.stringify({classId:Number(classId),date:day,version:register.version,reason:'Concurrent correction',entries:[{studentId:register.students[0].id,period:3,status:'A'}]})});
      done(response.status);
    })().catch(() => done(0));
  `, classId, date);
  assert.equal(concurrentStatus, 200, 'Concurrent editor must save successfully');
  await submit('#attendance-save');
  await waitText('#attendance-state', 'Your selections are preserved');
  assert.equal(await (await find('#attendance-rows select[data-period="4"]')).getAttribute('value'), 'A', 'Stale submission must preserve the unsaved selection');
  assert.equal(await (await find('#attendance-rows select[data-period="3"]')).getAttribute('value'), 'P', 'Stale submission must not silently replace visible edits');
  await click('#attendance-reload');
  await driver.wait(until.alertIsPresent(), 5000);
  await (await driver.switchTo().alert()).accept();
  await waitText('#attendance-state', 'Register loaded.');
  assert.deepEqual(await statuses(), ['P', 'A', 'A', 'P', 'P', 'P', 'U']);
  // Correct two saved marks, including clearing to U, with a reason.
  await setValue('#attendance-rows select[data-period="1"]', 'A');
  await setValue('#attendance-rows select[data-period="2"]', 'U');
  await setValue('#attendance-rows select[data-period="7"]', 'P');
  await type('#attendance-save input[name=reason]', 'Browser correction');
  await submit('#attendance-save');
  await waitText('#attendance-state', 'Attendance saved and reloaded.');
  assert.deepEqual(await statuses(), ['A', 'U', 'A', 'P', 'P', 'P', 'P']);
  t.diagnostic('All P1–P7 controls accepted P/A/U; stale save retained selections; correction was saved.');
  await click('[data-view=history]');
  await setValue('#history-filter select[name=classId]', classId);
  await setValue('#history-filter input[name=date]', date);
  await submit('#history-filter');
  await waitText('#history-heading', date);
  assert.match(await (await find('#history-rows')).getText(), /S001\s+Synthetic Student\s+A\s+U\s+A\s+P\s+P\s+P\s+P/);
  const audit = await (await find('#audit-rows')).getText();
  assert.match(audit, /P3\s+P\s+A\s+Concurrent correction/);
  assert.match(audit, /P1\s+P\s+A\s+Browser correction/);
  assert.match(audit, /P2\s+A\s+U\s+Browser correction/);
  t.diagnostic('History displayed concurrent and authorized correction audit entries, including clearing to U.');
  // A second student makes the individual report filter observable.
  await click('[data-view=students]');
  await setValue('#student-form select[name=classId]', classId);
  await type('#student-form input[name=roll]', 'S002');
  await type('#student-form input[name=name]', 'Second Synthetic Student');
  await type('#student-form input[name=department]', 'Test');
  await setValue('#student-form input[name=startDate]', date);
  await setValue('#student-form input[name=endDate]', date);
  await submit('#student-form');
  await waitText('#notice', 'Student saved.');
  assert.match(await (await find('#students-rows')).getText(), /S002\s+Second Synthetic Student/);
  await click('[data-view=reports]');
  await setValue('#reports-filter select[name=classId]', classId);
  await driver.wait(async () => (await driver.findElements(By.css('#reports-filter select[name=studentId] option'))).length === 3, 10000, 'Student report options did not load');
  await setValue('#reports-filter input[name=month]', '2024-04');
  await submit('#reports-filter');
  await waitText('#reports-heading', '2024-04');
  assert.match(await (await find('#reports-rows')).getText(), /S001\s+Synthetic Student\s+7\s+4\s+2\s+1\s+57\.14%\s+Preliminary/);
  const classRows = await driver.findElements(By.css('#reports-rows tr'));
  assert.equal(classRows.length, 2, 'Class report includes both students');
  const classStudentRow = await classRows[0].getText();
  await click('#csv');
  await waitText('#notice', 'CSV exported.');
  const csvFile = path.join(dir, 'attendance-2024-04.csv');
  await driver.wait(() => fs.existsSync(csvFile), 10000, 'CSV download did not appear');
  const csv = fs.readFileSync(csvFile, 'utf8');
  assert.match(csv, /Synthetic Student/);
  assert.match(csv, /57\.14/);
  assert.match(csv, /"7","4","2","1"/);
  const classCsvRow = csv.trim().split(/\r?\n/).find(line => line.includes('"S001"'));
  assert.ok(classCsvRow);
  assert.match(csv, /"S002"/);
  fs.unlinkSync(csvFile);
  const studentId = await driver.executeScript('return [...document.querySelectorAll("#reports-filter select[name=studentId] option")].find(x => x.textContent.includes("S001")).value');
  await setValue('#reports-filter select[name=studentId]', studentId);
  await submit('#reports-filter');
  await driver.wait(async () => (await driver.findElements(By.css('#reports-rows tr'))).length === 1, 10000, 'Individual report did not load');
  assert.equal(await (await find('#reports-rows tr')).getText(), classStudentRow, 'Individual report matches class report row');
  await click('#csv');
  await waitText('#notice', 'CSV exported.');
  await driver.wait(() => fs.existsSync(csvFile), 10000, 'Individual CSV download did not appear');
  const individualCsv = fs.readFileSync(csvFile, 'utf8').trim().split(/\r?\n/);
  assert.equal(individualCsv.length, 2, 'Individual CSV contains a header and one student');
  assert.equal(individualCsv[1], classCsvRow, 'Individual CSV matches class CSV row');
  t.diagnostic('Individual report and CSV match the selected student in the two-student class report and CSV.');
  if (!process.env.BASE_URL) {
    // Exercise the delivered backup and restore tools while the application is live.
    const dbFile = path.join(dir, 'test.sqlite');
    const backupFile = path.join(dir, 'backup.sqlite');
    const restoredFile = path.join(dir, 'restore.sqlite');
    execFileSync(process.execPath, ['ops/sqlite-copy.cjs', dbFile, backupFile], { stdio: 'pipe' });
    execFileSync(process.execPath, ['ops/sqlite-copy.cjs', backupFile, restoredFile], { stdio: 'pipe' });
    const result = execFileSync(process.execPath, ['ops/verify-restore.cjs', backupFile, restoredFile, classId, date, '2024-04'], { encoding: 'utf8' });
    assert.match(result, /2 students; attendance for 2024-04-01; 2 monthly reports and CSV for 2024-04/);
    t.diagnostic('Online backup and isolated restore matched student count, attendance, report and CSV.');
    await new Promise(resolve => server.close(resolve));
    server = null;
    db.close();
    db = openDatabase(dbFile);
    server = createApp(db).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await driver.get(base);
    await type('#login-form input[name=username]', username);
    await type('#login-form input[name=password]', password);
    await submit('#login-form');
    await driver.wait(async () => (await find('#app')).isDisplayed(), 10000, 'Sign in after restart failed');
    await click('[data-view=attendance]');
    await setValue('#attendance-filter select[name=classId]', classId);
    await setValue('#attendance-filter input[name=date]', date);
    await submit('#attendance-filter');
    await waitText('#register-title', date);
    assert.deepEqual(await statuses(), ['A', 'U', 'A', 'P', 'P', 'P', 'P']);
    t.diagnostic('Attendance survived a server and database restart.');
  }
});
