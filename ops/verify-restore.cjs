// Compare the backup and restored database through the running application API.
// Copies are opened in a private temporary directory; the supplied files stay untouched.
const { DatabaseSync, backup } = require('node:sqlite');
const { openDatabase } = require('../server/db');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/security');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function copy(source, target) {
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); } finally { db.close(); }
}
async function capture(file, classId, day, month) {
  const db = openDatabase(file);
  const username = `restore-check-${randomBytes(16).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO users(username,password_hash,role) VALUES (?,?,?)').run(username, hashPassword(password), 'admin');
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = await fetch(`${base}/api/session`);
    const token = (await session.json()).csrfToken;
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const login = await fetch(`${base}/api/login`, { method:'POST', headers:{'content-type':'application/json',cookie,'x-csrf-token':token}, body:JSON.stringify({username,password}) });
    if (!login.ok) throw new Error(`Temporary verifier login failed (${login.status})`);
    const authCookie = login.headers.get('set-cookie').split(';')[0];
    async function read(url) {
      const response = await fetch(base + url, { headers:{cookie:authCookie} });
      if (!response.ok) throw new Error(`Verification request failed (${response.status}): ${url}`);
      return response.text();
    }
    return {
      students: await read(`/api/students?classId=${classId}`),
      attendance: await read(`/api/attendance?classId=${classId}&date=${day}`),
      report: await read(`/api/reports?classId=${classId}&month=${month}`),
      csv: await read(`/api/reports.csv?classId=${classId}&month=${month}`)
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
}
async function main() {
  const [source, restored, classId, day, month, ...extra] = process.argv.slice(2);
  if (!source || !restored || !/^\d+$/.test(classId || '') || !/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !/^\d{4}-\d{2}$/.test(month || '') || extra.length) {
    throw new Error('Usage: node ops/verify-restore.cjs BACKUP RESTORED CLASS_ID YYYY-MM-DD YYYY-MM');
  }
  if (path.resolve(source) === path.resolve(restored)) throw new Error('Backup and restored files must be different.');
  if (!fs.existsSync(source) || !fs.existsSync(restored)) throw new Error('Both database files must exist.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-restore-check-'));
  try {
    const a=path.join(dir,'backup.sqlite'), b=path.join(dir,'restore.sqlite');
    await copy(source,a); await copy(restored,b);
    const expected=await capture(a,classId,day,month), actual=await capture(b,classId,day,month);
    for (const key of Object.keys(expected)) assert.equal(actual[key],expected[key],`${key} differs after restore`);
    const students=JSON.parse(actual.students).students;
    const report=JSON.parse(actual.report).students;
    console.log(`Restore matches backup: ${students.length} students; attendance for ${day}; ${report.length} monthly reports and CSV for ${month}.`);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
