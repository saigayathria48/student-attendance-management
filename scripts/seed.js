const { openDatabase, transaction } = require('../server/db');
const { hashPassword } = require('../server/security');
const db = openDatabase();
const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;
if (!username || !password || password.length < 12) {
  console.error('Set ADMIN_USERNAME and ADMIN_PASSWORD (at least 12 characters).');
  process.exitCode = 1;
} else {
  transaction(db, () => {
    if (!db.prepare('SELECT id FROM users WHERE role=? AND active=1').get('admin')) {
      db.prepare('INSERT INTO users(username,password_hash,role) VALUES (?,?,?)').run(username, hashPassword(password), 'admin');
      console.log('Initial admin created.');
    } else console.log('An admin already exists; credentials were not changed.');
    if (process.env.SEED_DEMO === 'true') {
      db.prepare('INSERT OR IGNORE INTO classes(name) VALUES (?)').run('Demo Class');
      const cls = db.prepare('SELECT id FROM classes WHERE name=?').get('Demo Class');
      for (const [roll,name] of [['D001','Demo Student One'],['D002','Demo Student Two'],['D003','Demo Student Three']]) {
        if (!db.prepare('SELECT id FROM enrollments WHERE class_id=? AND roll=?').get(cls.id,roll)) {
          const s = db.prepare('INSERT INTO students(name,department) VALUES (?,?)').run(name,'Demonstration');
          db.prepare('INSERT INTO enrollments(student_id,class_id,roll,start_date) VALUES (?,?,?,?)').run(s.lastInsertRowid,cls.id,roll,'2020-01-01');
        }
      }
      console.log('Synthetic demonstration class and students are available.');
    }
  });
}
db.close();
