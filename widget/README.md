# Still — home-screen month widget

A small iOS widget: **Still**, and under it a ring showing the days you have sat this
month over the length of the month — `2/30`.

## Why it is not part of the app

iOS home-screen widgets are drawn by WidgetKit, and only a native app installed from
the App Store can supply one. A web app added to the Home Screen cannot draw a widget,
and there is no web API that changes this. So the widget is a small
[Scriptable](https://apps.apple.com/app/scriptable/id1405459188) script (free) instead.

A widget also runs in its own sandbox, so it cannot read the app's `localStorage`.
It reads the copy of your record that the app already backs up to your Cloudflare
Worker, and counts a day the way the app does:

> a day counts if you finished a sit, or sat at least 5 minutes.

Two sits in one day count as one day — the top number is days sat, not sits.

**This means the widget needs the app's Backup connected.** If Settings → Backup still
says `off`, set the Worker up first — the widget has no other way to reach your record.

## Setup

1. Install **Scriptable** from the App Store.
2. In Still, open **Settings → Backup** and copy your Worker address and access key.
3. Open Scriptable, tap **+**, and paste in [`still-month.js`](still-month.js).
4. Fill in the three values at the top: `WORKER_URL`, `ACCESS_KEY`, `APP_URL`.
5. Name the script **Still Month** (tap the title), then tap ▶ to check it.
6. On the Home Screen: long-press → **+** → **Scriptable** → small widget → **Add**.
7. Long-press the new widget → **Edit Widget** → Script: **Still Month**.

Tapping the widget opens the app.

## If the ring shows `—`

That means the Worker did not answer. The widget reads with `GET`, while the app only
ever sends `POST`, so a Worker written for the app alone may not have a `GET` handler.
Add one — it returns the stored record and nothing else:

```js
if (request.method === 'GET') {
  if (request.headers.get('Authorization') !== 'Bearer ' + env.TOKEN) {
    return new Response('unauthorized', { status: 401 });
  }
  const stored = await env.STILL.get('data');          // your KV binding and key
  return new Response(stored || '{"log":[]}', {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

Deliberately read-only: the widget never writes, so it can never disturb your record.

The widget keeps the last figure it saw, so a refresh with no signal shows the previous
value with a small `·` after the month rather than going blank. A cached figure is only
reused within the same month, so a new month never opens on a stale count.

## Tweaks

- **Ring thickness** — `size * 0.115` in `ringImage`.
- **Figure sits high or low in the ring** — nudge `FONT_Y` (0.70) in `ringImage`.
  Text is placed from the top of its box, so this is the one number that may want a
  small adjustment on your device.
- **Ring size on the widget** — `img.imageSize` (88). It is drawn at 200px and scaled
  down, so it stays crisp if you enlarge it.

## Refresh timing

The script asks for a refresh every 30 minutes, but iOS decides when it can afford one,
so the ring can lag a finished sit by a while. Tapping the widget opens the app, which
is always current.

## A note on the app's own month line

The calendar sheet says *"N sits this month"* — that counts **sits**, while the widget
counts **days**. Two sits in one day make those two numbers differ, by design.
