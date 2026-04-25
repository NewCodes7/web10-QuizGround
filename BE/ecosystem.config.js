const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

module.exports = {
  apps: [
    {
      name: 'quiz-ground-was',
      script: 'dist/src/main.js',
      env: {
        WAS_PORT: 3000,
        PYROSCOPE_SERVER_URL: process.env.PYROSCOPE_SERVER_URL,
        PYROSCOPE_INSTANCE: process.env.PYROSCOPE_INSTANCE
      }
    }
  ]
};
