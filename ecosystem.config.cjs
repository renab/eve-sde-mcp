module.exports = {
  apps: [
    {
      name: "eve-sde-mcp",
      script: "dist/http.js",
      cwd: __dirname,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
