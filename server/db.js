const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function openDatabase(file = process.env.DB_PATH || path.join(process.cwd(), 'data', 'attendance.sqlite')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode=WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','faculty')), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
    CREATE TABLE IF NOT EXISTS classes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS assignments (user_id INTEGER NOT NULL REFERENCES users(id), class_id INTEGER NOT NULL REFERENCES classes(id), PRIMARY KEY(user_id,class_id));
    CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY, name TEXT NOT NULL, department TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
    CREATE TABLE IF NOT EXISTS enrollments (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id), class_id INTEGER NOT NULL REFERENCES classes(id), roll TEXT NOT NULL COLLATE NOCASE, start_date TEXT NOT NULL, end_date TEXT, CHECK(end_date IS NULL OR end_date >= start_date));
    CREATE TABLE IF NOT EXISTS calendar (date TEXT PRIMARY KEY, periods TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('threshold','75');
    CREATE TABLE IF NOT EXISTS attendance (student_id INTEGER NOT NULL REFERENCES students(id), class_id INTEGER NOT NULL REFERENCES classes(id), date TEXT NOT NULL, period INTEGER NOT NULL CHECK(period BETWEEN 1 AND 7), status TEXT NOT NULL CHECK(status IN ('P','A','U')), PRIMARY KEY(student_id,class_id,date,period));
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_one_class ON attendance(student_id,date,period);
    CREATE TABLE IF NOT EXISTS attendance_versions (class_id INTEGER NOT NULL REFERENCES classes(id), date TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(class_id,date));
    CREATE TABLE IF NOT EXISTS attendance_audit (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL, class_id INTEGER NOT NULL, date TEXT NOT NULL, period INTEGER NOT NULL, previous TEXT NOT NULL, value TEXT NOT NULL, reason TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), timestamp TEXT NOT NULL);
    INSERT OR IGNORE INTO schema_migrations VALUES (1);
  `);
  if (!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))');
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get()) {
    const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='enrollments'").get().sql;
    if (/UNIQUE\s*\(class_id\s*,\s*roll\)/i.test(sql)) db.exec(`BEGIN; ALTER TABLE enrollments RENAME TO enrollments_old; CREATE TABLE enrollments (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id), class_id INTEGER NOT NULL REFERENCES classes(id), roll TEXT NOT NULL COLLATE NOCASE, start_date TEXT NOT NULL, end_date TEXT, CHECK(end_date IS NULL OR end_date >= start_date)); INSERT INTO enrollments SELECT * FROM enrollments_old; DROP TABLE enrollments_old; COMMIT;`);
    db.exec('INSERT INTO schema_migrations VALUES (3)');
  }
  db.exec('INSERT OR IGNORE INTO schema_migrations VALUES (2)');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS enrollment_insert_guard BEFORE INSERT ON enrollments BEGIN
      SELECT RAISE(ABORT,'Roll number is already used in this class') WHERE EXISTS (SELECT 1 FROM enrollments e WHERE e.class_id=NEW.class_id AND e.roll=NEW.roll AND e.student_id<>NEW.student_id);
      SELECT RAISE(ABORT,'Enrollment overlaps another interval') WHERE EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id=NEW.student_id AND e.start_date<=COALESCE(NEW.end_date,'9999-12-31') AND NEW.start_date<=COALESCE(e.end_date,'9999-12-31'));
    END;
    CREATE TRIGGER IF NOT EXISTS enrollment_update_guard BEFORE UPDATE ON enrollments BEGIN
      SELECT RAISE(ABORT,'Roll number is already used in this class') WHERE EXISTS (SELECT 1 FROM enrollments e WHERE e.id<>NEW.id AND e.class_id=NEW.class_id AND e.roll=NEW.roll AND e.student_id<>NEW.student_id);
      SELECT RAISE(ABORT,'Enrollment overlaps another interval') WHERE EXISTS (SELECT 1 FROM enrollments e WHERE e.id<>NEW.id AND e.student_id=NEW.student_id AND e.start_date<=COALESCE(NEW.end_date,'9999-12-31') AND NEW.start_date<=COALESCE(e.end_date,'9999-12-31'));
    END;
  `);
  return db;
}
function transaction(db, fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
module.exports = { openDatabase, transaction };
