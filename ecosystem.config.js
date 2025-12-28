const path = require('path');

const baseDir = path.resolve(__dirname);

module.exports = {
  apps: [
    {
      name: 'instant',
      script: 'src/index.js',
      cwd: baseDir,
      args: 'src/configs/instant.ini --noconsole',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        HCAPTCHA_SECRET: 'ES_1164024ff8504a768b1bfd5a6e3dcbc1'
      }
    },

    {
      name: 'ffa',
      script: 'src/index.js',
      cwd: baseDir,
      args: 'src/configs/ffa.ini --noconsole',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        HCAPTCHA_SECRET: 'ES_1164024ff8504a768b1bfd5a6e3dcbc1'
      }
    },

    {
      name: 'gigasplit',
      script: 'src/index.js',
      cwd: baseDir,
      args: 'src/configs/gigasplit.ini --noconsole',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        HCAPTCHA_SECRET: 'ES_1164024ff8504a768b1bfd5a6e3dcbc1'
      }
    },

    {
      name: 'megasplit',
      script: 'src/index.js',
      cwd: baseDir,
      args: 'src/configs/megasplit.ini --noconsole',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        HCAPTCHA_SECRET: 'ES_1164024ff8504a768b1bfd5a6e3dcbc1'
      }
    },

    {
      name: 'crazy',
      script: 'src/index.js',
      cwd: baseDir,
      args: 'src/configs/crazy.ini --noconsole',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        HCAPTCHA_SECRET: 'ES_1164024ff8504a768b1bfd5a6e3dcbc1'
      }
    },

    {
      name: 'selfeed',
      script: 'src/index.js',
      cwd: baseDir,
      args: 'src/configs/selfeed.ini --noconsole',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        HCAPTCHA_SECRET: 'ES_1164024ff8504a768b1bfd5a6e3dcbc1'
      }
    },

    {
      name: 'selfeed-2',
      script: 'src/index.js',
      cwd: baseDir,
      args: 'src/configs/selfeed2.ini --noconsole',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        HCAPTCHA_SECRET: 'ES_1164024ff8504a768b1bfd5a6e3dcbc1'
      }
    },

    {
      name: 'terasplit',
      script: 'src/index.js',
      cwd: baseDir,
      args: 'src/configs/terasplit.ini --noconsole',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        HCAPTCHA_SECRET: 'ES_1164024ff8504a768b1bfd5a6e3dcbc1'
      }
    }
  ]
};

