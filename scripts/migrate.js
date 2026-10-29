const { openDatabase } = require('../server/db');
const db = openDatabase();
db.close();
console.log('Database schema is up to date.');
