import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';

export async function startStalledPostgres() {
  const sockets = new Set<Socket>();
  let querySeen = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => {
      // AuthenticationOk, BackendKeyData, ReadyForQuery (idle).
      socket.write(Buffer.from('5200000008000000004b0000000c000004d20000162e5a0000000549', 'hex'));
      socket.once('data', () => { querySeen = true; });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  return {
    url: `postgresql://fixture@127.0.0.1:${address.port}/fixture`,
    querySeen: () => querySeen,
    disconnect() { for (const socket of sockets) socket.destroy(); },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
