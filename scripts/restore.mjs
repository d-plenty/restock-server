#!/usr/bin/env node
// Restores a Restock server backup (the encrypted file from Settings → Backup on the server's web
// page) into a new, empty data folder:
//
//   node scripts/restore.mjs restock-server-backup.rsb /path/to/new/data
//
// It asks for the backup passphrase (or reads RESTOCK_BACKUP_PASSPHRASE). Then start the server with
// that folder as its data folder (DATA_DIR, or the volume in compose.yaml). Nothing is written to the
// folder unless the whole backup opens with the passphrase.

import { createInterface } from 'node:readline';
import { restoreInto } from '../src/v3/backup.mjs';

const [file, target] = process.argv.slice(2);
if (!file || !target) {
  console.error('Usage: node scripts/restore.mjs <backup file> <new, empty data folder>');
  process.exit(2);
}

function ask(question) {
  return new Promise((ok) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(question)) process.stdout.write(question);
    };
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write('\n');
      ok(a);
    });
  });
}

const pass = process.env.RESTOCK_BACKUP_PASSPHRASE ?? (await ask('Backup passphrase: '));
try {
  const names = await restoreInto(file, pass, target);
  console.log(`Restored ${names.length} files into ${target}.`);
  console.log('Start the Restock server with that folder as its data folder (DATA_DIR, or the /data volume).');
  console.log('If it runs in Docker as user 1000:  sudo chown -R 1000:1000 ' + target);
} catch (e) {
  console.error('Restore failed: ' + e.message);
  process.exit(1);
}
