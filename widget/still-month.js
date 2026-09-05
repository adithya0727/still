/* Still — month widget for Scriptable (iOS / iPadOS)
   --------------------------------------------------
   A home-screen widget showing a ring: the days you have sat this month over the
   number of days in the month, e.g. 2/30.

   iOS does not let a web app draw a home-screen widget, so the widget is a small
   Scriptable script instead. It cannot read the app's localStorage — a widget lives
   in a different sandbox — so it reads the record the app backs up to your Cloudflare
   Worker, and counts a day the same way the app does:

     a day counts if you finished a sit, or sat at least 5 minutes

   Two sits in one day still count as one day. Setup is in widget/README.md.
*/

// ---- your Worker, the same two values you typed into the app's Backup field ----
const WORKER_URL = 'https://still-sync.YOUR-SUBDOMAIN.workers.dev';
const ACCESS_KEY = 'PASTE-YOUR-ACCESS-KEY';

// where the app itself lives, so tapping the widget opens it
const APP_URL = 'https://YOUR-USERNAME.github.io/still/';

// ---- the app's palette ----
const DARK  = { bg:'#151b24', text:'#e7e3db', muted:'#8892a0', accent:'#d2a868', track:'#2b3440' };
const LIGHT = { bg:'#e6eae9', text:'#262c31', muted:'#737b82', accent:'#b4884e', track:'#cfd5d4' };

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const CACHE = FileManager.local().joinPath(
  FileManager.local().cacheDirectory(), 'still-month.json');

function pad2(n){ return (n < 10 ? '0' : '') + n; }
function dayKey(ms){
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* Days sat this month, over the length of the month.
   The qualifying rule matches logStats() in index.html — keep the two in step. */
function monthProgress(log, now){
  now = now || new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const total = new Date(y, m + 1, 0).getDate();      // days in this month

  const days = {};
  for (const e of log) {
    if (e && (e.c || e.s >= 300)) days[dayKey(e.at)] = true;   // finished, or 5 minutes
  }
  let sat = 0;
  for (let d = 1; d <= total; d++) {
    if (days[y + '-' + pad2(m + 1) + '-' + pad2(d)]) sat++;
  }
  return { sat, total, month: MONTHS[m] };
}

async function fetchLog(){
  const req = new Request(WORKER_URL.replace(/\/+$/, ''));
  req.method = 'GET';
  req.headers = { 'Authorization': 'Bearer ' + ACCESS_KEY };
  req.timeoutInterval = 15;
  const data = await req.loadJSON();
  if (!data || !Array.isArray(data.log)) throw new Error('no log in the reply');
  return data.log;
}

/* Keep the last good figure, so a refresh with no signal still shows something. */
function readCache(){
  try {
    const fm = FileManager.local();
    if (!fm.fileExists(CACHE)) return null;
    return JSON.parse(fm.readString(CACHE));
  } catch (e) { return null; }
}
function writeCache(p){
  try { FileManager.local().writeString(CACHE, JSON.stringify(p)); } catch (e) {}
}

async function getProgress(){
  try {
    const p = monthProgress(await fetchLog());
    writeCache(p);
    return { ...p, stale: false };
  } catch (e) {
    const c = readCache();
    // a cached figure from last month would be misleading, so only reuse this month's
    if (c && c.month === MONTHS[new Date().getMonth()]) return { ...c, stale: true };
    return { sat: null, total: monthProgress([]).total, month: MONTHS[new Date().getMonth()], stale: true };
  }
}

/* A ring drawn into an image: track circle, progress wedge, then the middle punched
   back out in the background colour, with the figure written across the centre. */
function ringImage(sat, total, c, size){
  const ctx = new DrawContext();
  ctx.size = new Size(size, size);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const mid = size / 2;
  const fraction = (sat === null || !total) ? 0 : Math.max(0, Math.min(1, sat / total));

  ctx.setFillColor(new Color(c.track));
  ctx.fillEllipse(new Rect(0, 0, size, size));

  if (fraction > 0) {
    const p = new Path();
    p.move(new Point(mid, mid));
    const steps = Math.max(2, Math.ceil(360 * fraction));   // one point per degree
    for (let i = 0; i <= steps; i++) {
      const a = (-90 + 360 * fraction * (i / steps)) * Math.PI / 180;
      p.addLine(new Point(mid + mid * Math.cos(a), mid + mid * Math.sin(a)));
    }
    p.closeSubpath();
    ctx.addPath(p);
    ctx.setFillColor(new Color(c.accent));
    ctx.fillPath();
  }

  const w = size * 0.115;                                   // ring thickness
  ctx.setFillColor(new Color(c.bg));
  ctx.fillEllipse(new Rect(w, w, size - 2 * w, size - 2 * w));

  // the figure, centred. Nudge FONT_Y if it sits high or low on your device.
  const FONT_Y = 0.70;
  const fs = size * 0.235;
  ctx.setTextAlignedCenter();
  ctx.setFont(Font.lightSystemFont(fs));
  ctx.setTextColor(new Color(sat === null ? c.muted : c.text));
  ctx.drawTextInRect(sat === null ? '—' : sat + '/' + total,
                     new Rect(0, mid - fs * FONT_Y, size, fs * 1.7));

  return ctx.getImage();
}

function build(p){
  const c = Device.isUsingDarkAppearance() ? DARK : LIGHT;

  const w = new ListWidget();
  w.backgroundColor = new Color(c.bg);
  w.setPadding(14, 14, 14, 14);
  w.url = APP_URL;

  const title = w.addText('Still');
  title.font = Font.mediumSystemFont(13);
  title.textColor = new Color(c.muted);
  title.centerAlignText();

  w.addSpacer(6);

  const img = w.addImage(ringImage(p.sat, p.total, c, 200));
  img.imageSize = new Size(88, 88);
  img.centerAlignImage();

  w.addSpacer(5);

  const foot = w.addText(p.month + (p.stale ? ' ·' : ''));
  foot.font = Font.systemFont(11);
  foot.textColor = new Color(c.muted);
  foot.centerAlignText();

  // ask iOS for a refresh in half an hour; it decides when it can afford one
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  return w;
}

const widget = build(await getProgress());
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentSmall();     // tap Run in Scriptable to preview it
Script.complete();
