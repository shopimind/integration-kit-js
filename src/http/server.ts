import Hapi from '@hapi/hapi';
import type { Server } from '@hapi/hapi';

export interface ServerOptions {
  port: number;
  host?: string;
}

/** Bare Hapi server (dual-stack by default, CORS off, validation logged). */
export function createServer(opts: ServerOptions): Server {
  return Hapi.server({
    port: opts.port,
    // INTENTIONAL: bind to 0.0.0.0 (all interfaces) by default. This server is meant to
    // run as a containerized service where the orchestrator / ingress controls exposure;
    // binding to a loopback-only address would make it unreachable from outside the pod.
    host: opts.host ?? '0.0.0.0',
    routes: {
      cors: false,
      // INTENTIONAL: failAction 'log' (do NOT reject). Routes parse the RAW request body
      // themselves (HMAC is computed over the exact bytes, payload.parse=false), so Joi
      // request validation is non-authoritative here -- making it blocking would risk
      // rejecting otherwise-valid signed requests. We log validation findings instead.
      validate: { failAction: 'log' },
      // The admin session reads the raw `Cookie` header itself; disable Hapi's built-in
      // cookie state parsing so a malformed or unrelated cookie can never 400 a request.
      state: { parse: false, failAction: 'ignore' },
    },
  });
}
