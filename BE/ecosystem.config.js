const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const heapProfDir = process.env.HEAP_PROF_DIR || path.join(os.homedir(), 'heap-profiles');

if (process.env.HEAP_PROF === '1') {
  require('fs').mkdirSync(heapProfDir, { recursive: true });
}

module.exports = {
  apps: [
    {
      name: 'quiz-ground-was',
      script: 'dist/src/main.js',
      ...(process.env.HEAP_PROF === '1' && {
        node_args: `--heap-prof --heap-prof-dir=${heapProfDir} --heap-prof-interval=1024`,
        kill_timeout: 10000
      }),
      env: {
        WAS_PORT: 3000,
      }
    }
  ]
};
