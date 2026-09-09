// Regression tripwire, not a production sandbox. Child processes need OS controls too.
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const deny = operation => function () {
  fs.appendFileSync(process.env.MASON_TEST_NETWORK_LOG, operation + '\n');
  throw new Error('Network forbidden during core-operation test: ' + operation);
};
globalThis.fetch = deny('fetch');
for (const [name, target, methods] of [
  ['net', net, ['connect', 'createConnection']], ['socket', net.Socket.prototype, ['connect']],
  ['server', net.Server.prototype, ['listen']], ['tls', tls, ['connect']],
  ['http', http, ['request', 'get']], ['https', https, ['request', 'get']],
  ['dns', dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ['dns.promises', dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ['dgram', dgram, ['createSocket']],
]) for (const method of methods) target[method] = deny(name + '.' + method);
syncBuiltinESMExports();
