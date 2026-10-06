window.__ModuleLoader__.load({
  id: '@local/better-dsh-web-restart',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dshRestartButton';
    /** Same-origin liveness probe; any HTTP response means the server is up. */
    const STATUS_URL = '/restart-dsh/status';
    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'button.restart': '重启 DSH 服务',
      'button.cancel': '取消重启',
      'status.online': '服务在线',
      'status.offline': '服务已掉线',
      'group.label': 'DSH 服务状态与重启'
    };
    /** English dictionary, same key set. */
    const en = {
      'button.restart': 'Restart DSH service',
      'button.cancel': 'Cancel restart',
      'status.online': 'Service online',
      'status.offline': 'Service offline',
      'group.label': 'DSH service status and restart'
    };

    /**
     * One status probe. A network failure means offline; any HTTP response
     * (even a 404 from a half-loaded Host) means the server is reachable.
     * @returns the next status snapshot.
     */
    async function probe() {
      try {
        const res = await fetch(STATUS_URL, {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000)
        });
        if (!res.ok) return { online: true, armed: false, killAt: null };
        const body = await res.json().catch(() => null);
        if (!body || body.ok !== true) return { online: true, armed: false, killAt: null };
        return { online: true, armed: body.armed === true, killAt: body.killAt ?? null };
      } catch {
        return { online: false, armed: false, killAt: null };
      }
    }

    /**
     * Header control: status light + restart button. Polls faster while offline
     * or counting down so the light recovers promptly after systemd relaunches
     * the service (ready 6-8s after the kill).
     * @param props - `t` from the slot's locale binding.
     * @returns the element tree.
     */
    function RestartControl({ t }) {
      // Fall back to the zh dictionary if the slot hands no translator.
      const tr = typeof t === 'function' ? t : (key) => zh[key] ?? key;
      const [status, setStatus] = React.useState({ online: true, armed: false, killAt: null });
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        let stopped = false;
        let timer = null;
        const schedule = (ms) => {
          timer = window.setTimeout(tick, ms);
        };
        const tick = async () => {
          const next = await probe();
          if (stopped) return;
          setStatus(next);
          // Steady state breathes slowly; offline and the armed countdown poll once a second.
          schedule(next.online && !next.armed ? 3000 : 1000);
        };
        schedule(0);
        return () => {
          stopped = true;
          if (timer !== null) window.clearTimeout(timer);
        };
      }, []);

      const remaining =
        status.armed && status.killAt !== null
          ? Math.max(0, Math.ceil((status.killAt - Date.now()) / 1000))
          : 0;

      async function onAction() {
        if (busy || !status.online) return;
        setBusy(true);
        try {
          await fetch(status.armed ? '/restart-dsh/cancel' : '/restart-dsh/arm?delay=5', {
            method: 'POST',
            cache: 'no-store',
            signal: AbortSignal.timeout(3000)
          });
          setStatus(await probe());
        } catch {
          /* the polling loop reports the real state moments later */
        } finally {
          setBusy(false);
        }
      }

      const dotColor = status.online
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-state-error-primary)';
      const aria = status.online ? tr('status.online') : tr('status.offline');
      const tip = status.armed
        ? `${tr('button.cancel')} (${remaining}s)`
        : status.online
          ? tr('button.restart')
          : tr('status.offline');

      return h('span', {
        className: 'dshRestartGroup',
        role: 'group',
        'aria-label': tr('group.label')
      },
      h('style', null, [
        '.dshRestartGroup{display:inline-flex;align-items:center;gap:6px}',
        '.dshRestartDot{width:9px;height:9px;border-radius:50%;corner-shape:round;flex:0 0 auto;transition:background-color 240ms ease;box-shadow:0 0 4px currentColor}',
        '.dshRestartButton{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:600 11px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums}',
        '.dshRestartButton:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
        '.dshRestartButton:disabled{opacity:.5;cursor:default}',
        '.dshRestartButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}'
      ]),
      h('span', {
        className: 'dshRestartDot',
        'aria-hidden': 'true',
        title: aria,
        style: { backgroundColor: dotColor, color: dotColor }
      }),
      h('button', {
        type: 'button',
        className: 'dshRestartButton',
        disabled: busy || !status.online,
        'aria-label': tip,
        title: tip,
        onClick: onAction
      },
      status.armed
        ? String(remaining)
        : h('svg', {
          viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
          strokeLinejoin: 'round', 'aria-hidden': 'true'
        },
        h('path', { d: 'M23 4v6h-6' }),
        h('path', { d: 'M1 20v-6h6' }),
        h('path', { d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10' }),
        h('path', { d: 'M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }))));
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale'];

    /**
     * Register the dictionary and the header entry at the far left of the
     * session header utilities (order -100 sits before every host entry,
     * left of the "…" menu).
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'better-dsh-web-restart: dictionary');
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'better-dsh-web-restart',
        // Ascending order; -100 keeps the light+button at the far left, before the "…" menu.
        order: -100,
        label: 'Restart DSH',
        locale: NS
      }, RestartControl));
    }

    return { inject, apply };
  },
});
