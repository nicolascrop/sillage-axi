// Validation under an explicit no-service-start hold. Imported in the parent
// and inherited by Node test children; fail closed on any TCP/HTTP/Unix listener.
import { Server } from 'node:net';
Server.prototype.listen = function () {
  throw new Error('Service startup is forbidden in test:no-service');
};
