const path = require('path');
const result = require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const dotenvVars = result.parsed || {};

module.exports = {
  apps: [
    {
      name: 'quiz-ground-was',
      script: 'dist/src/main.js',
      exec_mode: 'cluster',
      instances: 'max',
      kill_timeout: 30000,
      max_open_files: 65535,
      env: {
        ...dotenvVars,
        WAS_PORT: 1027,
      }
    }
  ]
};
