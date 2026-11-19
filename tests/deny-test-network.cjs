// Used only by fixture test processes, never by package acquisition or user services.
const net = require('node:net');
const dns = require('node:dns');
const deny = () => { throw new Error('QUALIFICATION_NETWORK_DENIED'); };
net.Socket.prototype.connect = deny;
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  dns[name] = deny;
  if (dns.promises[name]) dns.promises[name] = async () => deny();
}
globalThis.fetch = async () => deny();
globalThis.WebSocket = class { constructor() { deny(); } };
