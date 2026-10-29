// SQLite's online backup API captures a consistent snapshot while the source is in use.
// Usage: node ops/sqlite-copy.cjs SOURCE DESTINATION
const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const [sourceArg, destinationArg, ...extra] = process.argv.slice(2);
  if (!sourceArg || !destinationArg || extra.length) {
    throw new Error('Usage: node ops/sqlite-copy.cjs SOURCE DESTINATION');
  }
  const source = path.resolve(sourceArg);
  const destination = path.resolve(destinationArg);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('Source database does not exist.');
  if (source === destination || fs.existsSync(destination)) throw new Error('Destination must be a new, separate file.');
  if (!fs.existsSync(path.dirname(destination))) throw new Error('Destination directory does not exist.');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    const result = copy.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || Object.values(result[0])[0] !== 'ok') throw new Error('Destination failed integrity_check.');
  } finally {
    copy.close();
  }
  console.log(`Consistent SQLite copy written and integrity checked: ${destination}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
