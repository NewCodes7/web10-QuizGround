module.exports = {
  apps: [
    {
      name: 'quiz-ground-was',
      script: 'dist/src/main.js',
      env: {
        WAS_PORT: 3000
      }
    }
  ]
};
