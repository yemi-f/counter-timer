import { DurableObject } from 'cloudflare:workers';
import { buildPushHTTPRequest } from '@pushforge/builder';

const MAX_AHEAD_MS = 3 * 60 * 60 * 1000; // refuse alarms more than 3h out
const LATE_MS = 60 * 1000;               // skip pushes for alarms that ran this late
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (data, status = 200) => Response.json(data, { status });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/vapid-public-key' && request.method === 'GET') {
      return json({ key: env.VAPID_PUBLIC_KEY });
    }

    if (request.method === 'POST' && (pathname === '/api/schedule' || pathname === '/api/cancel')) {
      let input;
      try { input = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!UUID_RE.test(input?.deviceId ?? '')) return json({ error: 'bad deviceId' }, 400);
      if (!Number.isFinite(input.seq)) return json({ error: 'bad seq' }, 400);

      const stub = env.REST_ALARM.get(env.REST_ALARM.idFromName(input.deviceId));

      if (pathname === '/api/cancel') {
        await stub.cancel(input.seq);
        return json({ ok: true });
      }

      const { subscription, fireAt, target } = input;
      const now = Date.now();
      if (!isValidSubscription(subscription)) return json({ error: 'bad subscription' }, 400);
      if (!Number.isFinite(fireAt) || fireAt <= now || fireAt > now + MAX_AHEAD_MS) {
        return json({ error: 'bad fireAt' }, 400);
      }
      await stub.schedule(input.seq, {
        subscription: { endpoint: subscription.endpoint, keys: subscription.keys },
        fireAt,
        target: Number.isInteger(target) ? target : 0,
      });
      return json({ ok: true });
    }

    if (pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};

function isValidSubscription(s) {
  try {
    return new URL(s.endpoint).protocol === 'https:' &&
      typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
  } catch {
    return false;
  }
}

function formatSeconds(total) {
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// One instance per device: holds the latest scheduled rest alarm.
export class RestAlarm extends DurableObject {
  // Requests can arrive out of order (e.g. leaving and reopening the app quickly);
  // seq increases with every request, so anything older than the last one is ignored.
  async #accept(seq) {
    const last = (await this.ctx.storage.get('seq')) ?? 0;
    if (seq <= last) return false;
    await this.ctx.storage.put('seq', seq);
    return true;
  }

  async schedule(seq, job) {
    if (!(await this.#accept(seq))) return;
    await this.ctx.storage.put('job', job);
    await this.ctx.storage.setAlarm(job.fireAt); // replaces any earlier alarm
  }

  async cancel(seq) {
    if (!(await this.#accept(seq))) return;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete('job');
  }

  async alarm() {
    const job = await this.ctx.storage.get('job');
    if (!job) return;
    if (Date.now() - job.fireAt > LATE_MS) {
      await this.ctx.storage.delete('job');
      return;
    }

    const { endpoint, headers, body } = await buildPushHTTPRequest({
      privateJWK: this.env.VAPID_PRIVATE_JWK,
      subscription: job.subscription,
      message: {
        payload: { title: 'Rest over', body: `${formatSeconds(job.target)} up` },
        adminContact: this.env.VAPID_SUBJECT,
        options: { ttl: 60, urgency: 'high', topic: 'rest' },
      },
    });

    const res = await fetch(endpoint, { method: 'POST', headers, body });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      // Transient failure: throwing makes Cloudflare retry the alarm.
      // The LATE_MS check above stops retries once the push would be stale.
      throw new Error(`push failed: ${res.status} ${await res.text()}`);
    }
    // Sent, or the subscription is gone (404/410): either way this job is done,
    // unless a new tap scheduled a fresh job while the push was in flight.
    const current = await this.ctx.storage.get('job');
    if (current?.fireAt === job.fireAt) await this.ctx.storage.delete('job');
  }
}
