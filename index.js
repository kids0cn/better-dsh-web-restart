import { spawn } from 'node:child_process';

/**
 * Host half of @local/better-dsh-web-restart.
 *
 * Exposes three exact HTTP routes consumed by the Client half:
 *   GET  /restart-dsh/status  -> { ok, service, armed, killAt }   (also the liveness probe)
 *   POST /restart-dsh/arm     -> arms the delayed kill            (?delay=<seconds>, clamped)
 *   POST /restart-dsh/cancel  -> withdraws a pending kill
 *
 * The kill itself is the proven recipe from ~/.dsh/AGENTS.md: spawn a detached
 * killer that sleeps, then `kill -9` the service MainPID; systemd's
 * Restart=on-failure + RestartSec=3 pulls the process back 3-4s later and HTTP
 * is ready 6-8s after that. `detached: true` gives the killer its own session
 * (setsid) and `stdio: 'ignore'` removes any terminal dependency (nohup), so it
 * survives the very SIGKILL it is about to deliver. The default 45s delay keeps
 * an in-flight agent reply safe — killing immediately would cut it off.
 *
 * Origin guard: cross-site HTML form POSTs carry an `Origin` we do not own;
 * curl and same-origin fetches either omit it or match the Host header.
 */

/** Service unit whose MainPID the delayed kill targets. */
const SERVICE = 'dsh-web.service';
/** Default seconds between arming and the kill (protects an in-flight reply). */
const DEFAULT_DELAY_SECONDS = 45;
const MIN_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 600;

export const inject = ['webServer'];

export function apply(ctx) {
  /** Epoch ms of the scheduled kill, or null when nothing is armed. */
  let armedUntil = null;
  /** The detached killer process while one is pending. */
  let killer = null;

  /** Withdraw a pending kill by taking down its whole process group. */
  function disarm() {
    if (killer !== null) {
      const child = killer;
      killer = null;
      // detached => the killer leads its own process group, so -pid reaches sleep too
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    armedUntil = null;
  }

  /**
   * Arm the delayed kill. A second call while armed keeps the first deadline
   * (the reply we are protecting may already be counting on it).
   * @returns the kill deadline and whether this call created it.
   */
  function arm(delaySeconds) {
    if (killer !== null) return { killAt: armedUntil, created: false };
    const script = `sleep ${delaySeconds}; kill -9 $(systemctl show ${SERVICE} -p MainPID --value)`;
    const child = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' });
    // A normal exit here means the kill could not run (spawn error or systemctl
    // failed); after a successful kill this process no longer exists to hear it.
    const drop = () => {
      if (killer === child) {
        killer = null;
        armedUntil = null;
      }
    };
    child.on('error', drop);
    child.on('exit', drop);
    child.unref();
    killer = child;
    armedUntil = Date.now() + delaySeconds * 1000;
    return { killAt: armedUntil, created: true };
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify(body));
  }

  /** Refuse cross-site form POSTs; curl and same-origin fetches pass. */
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function requirePost(res, req) {
    if (req.method === 'POST') return true;
    sendJson(res, 405, { ok: false, error: 'POST only' });
    return false;
  }

  ctx.effect(() => {
    const offStatus = ctx.webServer.register({
      kind: 'exact',
      path: '/restart-dsh/status',
      handler(req, res) {
        sendJson(res, 200, {
          ok: true,
          service: SERVICE,
          armed: killer !== null,
          killAt: armedUntil
        });
      }
    });

    const offArm = ctx.webServer.register({
      kind: 'exact',
      path: '/restart-dsh/arm',
      handler(req, res) {
        if (!requirePost(res, req)) return;
        if (!originAllowed(req)) {
          sendJson(res, 403, { ok: false, error: 'origin not allowed' });
          return;
        }
        const query = new URL(req.url, 'http://localhost').searchParams;
        const rawDelay = query.get('delay'); // null when absent — Number(null) is 0, not NaN
        const parsed = rawDelay === null ? Number.NaN : Number(rawDelay);
        const delaySeconds = Number.isFinite(parsed)
          ? Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(parsed)))
          : DEFAULT_DELAY_SECONDS;
        const { killAt, created } = arm(delaySeconds);
        sendJson(res, 200, { ok: true, service: SERVICE, killAt, delaySeconds, created });
      }
    });

    const offCancel = ctx.webServer.register({
      kind: 'exact',
      path: '/restart-dsh/cancel',
      handler(req, res) {
        if (!requirePost(res, req)) return;
        if (!originAllowed(req)) {
          sendJson(res, 403, { ok: false, error: 'origin not allowed' });
          return;
        }
        const wasArmed = killer !== null;
        disarm();
        sendJson(res, 200, { ok: true, cancelled: wasArmed });
      }
    });

    return () => {
      offStatus();
      offArm();
      offCancel();
      // Unloading the plugin withdraws any pending kill with it.
      disarm();
    };
  }, 'better-dsh-web-restart: http routes');
}
