module.exports = { apps: [{ name: 'pro-order-flow', cwd: __dirname, script: 'server.js', exec_mode: 'fork', instances: 1, watch: false, kill_timeout: 5000, env: { NODE_ENV: 'production' } }] };
