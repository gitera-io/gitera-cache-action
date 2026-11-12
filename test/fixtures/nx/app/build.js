'use strict';

// Writes an output that depends on the run, so each CI run starts with a miss.
const fs = require('node:fs');

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/out.txt', `built for ${process.env.GITERA_E2E_SALT}\n`);
console.log('BUILD RAN');
