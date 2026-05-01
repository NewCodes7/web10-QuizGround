const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const heapProfDir = path.join(os.homedir(), 'heap-profiles');
require('fs').mkdirSync(heapProfDir, { recursive: true });

module.exports = {
  apps: [
    {
      name: 'quiz-ground-was',
      script: 'dist/src/main.js',
      node_args: `--heap-prof --heap-prof-dir=${heapProfDir} --heap-prof-interval=1024`,
      kill_timeout: 30000,
      env: {
        WAS_PORT: 3000,
      }
    }
  ]
};
