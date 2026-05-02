const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

module.exports = {
  apps: [
    {
      name: 'quiz-ground-was',
      script: 'dist/src/main.js',
      kill_timeout: 30000,
      env: {
        WAS_PORT: 3000,
      }
    }
  ]
};
