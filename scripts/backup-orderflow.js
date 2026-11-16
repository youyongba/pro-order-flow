'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { insideRoot } = require('../lib/runtime');

async function main() {
  const target = process.argv[2];
  if (!target || !path.isAbsolute(target)) {
    throw new Error('Usage: npm run backup:orderflow -- /absolute/path/backup.sqlite');
  }
  const db = new Database(insideRoot('data/order_flow.sqlite'), { readonly: true, fileMustExist: true });
  let reserved = false;
  try {
    const fd = fs.openSync(target, 'wx', 0o600);
    reserved = true;
    fs.closeSync(fd);
    await db.backup(target);
    const copy = new Database(target, { readonly: true });
    try {
      if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup integrity check failed');
    } finally { copy.close(); }
    console.log('Order-flow backup verified: ' + target);
  } catch (error) {
    if (reserved) fs.unlinkSync(target);
    throw error;
  } finally { db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
