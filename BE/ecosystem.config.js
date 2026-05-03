const path = require('path');
const result = require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const dotenvVars = result.parsed || {};

module.exports = {
  apps: [
    {
      name: 'quiz-ground-was',
      script: 'dist/src/main.js',
      kill_timeout: 30000,
      env: {
        ...dotenvVars,
        WAS_PORT: 3000,
      }
    }
  ]
};
