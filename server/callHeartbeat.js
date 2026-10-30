export function startCallHeartbeat(wss, intervalMs = 10000) {
  wss.on('connection', socket => {
    socket.callAlive = true;
    socket.on('pong', () => { socket.callAlive = true; });
  });
  const timer = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.readyState !== 1) continue;
      if (!socket.callAlive) {
        socket.terminate();
        continue;
      }
      socket.callAlive = false;
      socket.ping();
    }
  }, intervalMs);
  timer.unref();
  wss.on('close', () => clearInterval(timer));
}
