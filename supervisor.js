// Built-in supervisor. However Thoth is started (npm start, node server.js, systemd, Docker), the first
// process becomes this small supervisor and runs the real server as a child process:
//   - the server exits with code 75  → it asked to be restarted (an update was installed, or an admin
//     clicked Restart server): start it again right away, with the code now on disk
//   - the server crashes             → start it again after a second (give up after 5 crashes a minute)
//   - Ctrl+C / systemctl stop / docker stop → tell the server to shut down cleanly, then exit
// Keep this file small and stable: it is only reloaded when the whole process is restarted.
const { fork } = require('child_process');
const path = require('path');

const RESTART_CODE = 75;

module.exports = function supervise() {
  let child = null, stopping = false, restarts = 0, crashes = [];

  function start() {
    child = fork(path.join(__dirname, 'server.js'), process.argv.slice(2), {
      env: Object.assign({}, process.env, {
        THOTH_SERVER_PROCESS: '1',
        THOTH_SUPERVISOR_PID: String(process.pid),
        THOTH_RESTARTS: String(restarts)
      }),
      execArgv: process.execArgv,
      stdio: 'inherit'
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return process.exit(code || 0);
      if (code === RESTART_CODE) {
        restarts++;
        console.log('[supervisor] restarting the server…');
        return start();
      }
      if (code === 0) return process.exit(0);
      const now = Date.now();
      crashes = crashes.filter(t => now - t < 60000).concat(now);
      if (crashes.length >= 5) {
        console.error('[supervisor] the server crashed 5 times in a minute; giving up');
        return process.exit(code || 1);
      }
      console.error(`[supervisor] the server stopped unexpectedly (${signal || 'exit code ' + code}); restarting in 1 s`);
      restarts++;
      setTimeout(start, 1000);
    });
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    if (!child) return process.exit(0);
    // Ask for a clean shutdown (saves data, stops scan processes); force it if it takes too long
    try { child.send({ type: 'shutdown' }); } catch { /* channel closed */ }
    setTimeout(() => { if (child) child.kill('SIGKILL'); process.exit(0); }, 10000).unref();
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  start();
};

module.exports.RESTART_CODE = RESTART_CODE;
