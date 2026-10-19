import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = process.env.E2E_OUT ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
fs.mkdirSync(OUT, { recursive: true });
const URL0 = process.env.APP_URL ?? 'http://localhost:4173/';
const log = (...a) => console.log('•', ...a);
const assert = (c, m) => {
  if (!c) throw new Error('ASSERT: ' + m);
  log('OK', m);
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 });
const A = await ctxA.newPage();
const pageErrors = [];
A.on('pageerror', (e) => { pageErrors.push(String(e)); console.error('PAGEERROR A', e); });
A.on('console', (m) => m.type() === 'error' && console.error('CONSOLE A', m.text()));
A.on('dialog', (d) => { pageErrors.push('dialog: ' + d.message()); console.error('DIALOG A', d.message()); void d.dismiss(); });
const cdpA = await ctxA.newCDPSession(A);

const objCount = (p) => p.evaluate(() => window.__inknote.doc.objects(window.__inknote.doc.pages[0].id).length);
const objsOf = (p, idx = 0) => p.evaluate((i) => {
  const d = window.__inknote.doc;
  return d.objects(d.pages[i].id).map((o) => ({ type: o.type, tool: o.tool, id: o.id, n: o.pts ? o.pts.length / 3 : 0, revealed: o.revealed }));
}, idx);

/** 페이지 좌표 → 뷰포트 좌표 */
async function toScreen(p, pts, pageIdx = 0) {
  return p.evaluate(([pts, pageIdx]) => {
    const ed = window.__inknote.editor;
    const r = document.querySelector('.editor-root').getBoundingClientRect();
    const rect = ed.rects[pageIdx];
    return pts.map(([x, y, f]) => {
      const [sx, sy] = ed.pageToScreen(rect, x, y);
      return [sx + r.left, sy + r.top, f];
    });
  }, [pts, pageIdx]);
}

/** CDP 로 실제 펜(pointerType=pen, 필압=force) 입력 */
async function stroke(cdp, p, pagePts, { pointerType = 'pen', pageIdx = 0 } = {}) {
  const pts = await toScreen(p, pagePts, pageIdx);
  const ev = (type, [x, y, f], buttons) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, force: f ?? 0.5, pointerType });
  await ev('mousePressed', pts[0], 1);
  for (const q of pts.slice(1)) await ev('mouseMoved', q, 1);
  await ev('mouseReleased', pts.at(-1), 0);
  await p.waitForTimeout(30);
}

/** 손글씨 흉내: 필압이 변하는 곡선들 */
function cursive(x0, y0, w, loops, amp = 14) {
  const out = [];
  const N = 120;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = t * loops * Math.PI * 2;
    out.push([x0 + t * w + Math.sin(a) * 6, y0 - Math.abs(Math.sin(a / 2)) * amp + Math.cos(a) * 4, 0.15 + 0.8 * Math.sin(Math.PI * t) ** 1.5]);
  }
  return out;
}
const line = (x0, y0, x1, y1, n = 30, f = 0.5) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, f]);

// ───────────── 1. 새 노트 + 펜 필기 ─────────────
await A.goto(URL0);
await A.getByRole('button', { name: '새 노트', exact: true }).click();
await A.getByRole('button', { name: '줄노트' }).click();
await A.waitForFunction(() => window.__inknote?.editor?.rects.length === 1);
await A.waitForTimeout(300);

await A.keyboard.press('p');
await stroke(cdpA, A, cursive(80, 130, 180, 5));
await stroke(cdpA, A, cursive(290, 130, 150, 4, 18));
// 빠른 획(속도 → 얇아짐) vs 느린 강한 필압
await stroke(cdpA, A, line(80, 175, 280, 160, 12, 0.35));
await stroke(cdpA, A, line(300, 160, 480, 178, 90, 0.95));
// 손글씨 "ㄱㄴ"
await stroke(cdpA, A, [[90, 220, 0.3], ...line(90, 220, 130, 220, 15, 0.7), ...line(130, 220, 128, 262, 15, 0.8)]);
await stroke(cdpA, A, [...line(150, 220, 150, 260, 15, 0.7), ...line(150, 260, 195, 260, 15, 0.5)]);

await A.keyboard.press('n'); // 연필
await stroke(cdpA, A, cursive(240, 260, 200, 5, 16));

await A.keyboard.press('b'); // 필압 없는 펜 (마우스)
await stroke(cdpA, A, cursive(80, 320, 200, 4), { pointerType: 'mouse' });

await A.keyboard.press('m'); // 마카
await stroke(cdpA, A, cursive(320, 320, 160, 3), { pointerType: 'mouse' });

await A.keyboard.press('h'); // 형광펜
await stroke(cdpA, A, line(75, 128, 450, 126, 40), { pointerType: 'mouse' });

await A.keyboard.press('u'); // 밑줄 (약간 기울여도 수평 스냅)
await stroke(cdpA, A, line(80, 345, 270, 352, 20), { pointerType: 'mouse' });

await A.keyboard.press('s'); // 도형
await A.getByRole('button', { name: '원' }).click();
await stroke(cdpA, A, line(330, 400, 470, 470, 20), { pointerType: 'mouse' });
await A.getByRole('button', { name: '화살표' }).click();
await stroke(cdpA, A, line(90, 440, 290, 420, 20), { pointerType: 'mouse' });

await A.keyboard.press('t'); // 암기 테이프
await stroke(cdpA, A, line(290, 128, 445, 124, 20), { pointerType: 'mouse' });

// 자: 자 가장자리 근처에서 비뚤게 그어도 직선
await A.keyboard.press('p');
await A.getByTitle(/^자/).click();
const rulerEdge = await A.evaluate(() => {
  const ed = window.__inknote.editor;
  const rect = ed.rects[0];
  const r = ed.ruler;
  r.cx = rect.x + 400;
  r.cy = rect.y + 370;
  return [r.cx - rect.x, r.cy - rect.y + (ed.ruler.thickness / 2 + 8) / ed.zoom];
});
await stroke(cdpA, A, Array.from({ length: 40 }, (_, i) => [rulerEdge[0] - 120 + i * 6, rulerEdge[1] + Math.sin(i) * 3, 0.6]));
await A.screenshot({ path: path.join(OUT, '01-handwriting.png') });
await A.getByTitle(/^자/).click();

let objs = await objsOf(A);
log('objects', objs.map((o) => `${o.type}:${o.tool ?? ''}`).join(' '));
assert(objs.length === 15, `15 objects drawn (got ${objs.length})`);
const ruled = await A.evaluate(() => {
  const d = window.__inknote.doc;
  const s = d.objects(d.pages[0].id).at(-1);
  const ys = s.pts.filter((_, i) => i % 3 === 1);
  return Math.max(...ys) - Math.min(...ys);
});
assert(ruled < 0.5, `ruler stroke is straight (y spread ${ruled.toFixed(3)})`);
const widthVar = await A.evaluate(() => {
  const d = window.__inknote.doc;
  const s = d.objects(d.pages[0].id).find((o) => o.tool === 'pen');
  const ws = s.pts.filter((_, i) => i % 3 === 2);
  return [Math.min(...ws), Math.max(...ws)];
});
assert(widthVar[1] / widthVar[0] > 1.8, `pen width varies with pressure/speed (${widthVar.map((v) => v.toFixed(2))})`);

// 테이프 탭 → 보임
const tapeTap = await toScreen(A, [[360, 126]]);
await A.keyboard.press('t');
await A.mouse.click(tapeTap[0][0], tapeTap[0][1]);
assert((await objsOf(A)).find((o) => o.type === 'tape').revealed === true, 'tape tap reveals');

// ───────────── 2. 지우개 3종 ─────────────
await A.keyboard.press('e');
await A.getByRole('button', { name: '부분 지우개' }).click();
const before = (await objsOf(A)).length;
await stroke(cdpA, A, line(380, 300, 380, 345, 10), { pointerType: 'mouse' }); // 마카 획 가운데
const afterPartial = await objsOf(A);
assert(afterPartial.length === before + 1, `partial eraser split marker stroke (${before} → ${afterPartial.length})`);

await A.getByRole('button', { name: '형광펜만' }).click();
await stroke(cdpA, A, line(200, 100, 200, 150, 10), { pointerType: 'mouse' }); // 형광펜 + 펜 획 교차
const afterHl = await objsOf(A);
assert(!afterHl.some((o) => o.tool === 'highlighter') && afterHl.filter((o) => o.tool === 'pen').length === 7, 'highlighter-only eraser keeps ink');

await A.getByRole('button', { name: '획 지우개' }).click();
await stroke(cdpA, A, line(150, 235, 150, 245, 4), { pointerType: 'mouse' }); // ㄴ
assert((await objsOf(A)).length === afterHl.length - 1, 'stroke eraser removes whole stroke');
await A.keyboard.press('Control+z');
assert((await objsOf(A)).length === afterHl.length, 'undo restores erased stroke');
await A.screenshot({ path: path.join(OUT, '02-erasers.png') });

// ───────────── 3. 올가미: 선택 → 이동 → 크기 조절 → 삭제 ─────────────
await A.keyboard.press('l');
const lasso = [];
for (let i = 0; i <= 60; i++) {
  const a = (i / 60) * Math.PI * 2;
  lasso.push([140 + Math.cos(a) * 75, 240 + Math.sin(a) * 38, 0.5]);
}
await stroke(cdpA, A, lasso, { pointerType: 'mouse' });
const sel = await A.evaluate(() => window.__inknote.editor.state.selection);
assert(sel && sel.ids.length === 2, `lasso selected ㄱ,ㄴ (${sel?.ids.length})`);
const bb0 = await A.evaluate(() => {
  const ed = window.__inknote.editor;
  const objs = ed.state.selection.ids.map((id) => ed.doc.object(id));
  const xs = objs.flatMap((o) => o.pts.filter((_, i) => i % 3 === 0));
  return [Math.min(...xs), Math.max(...xs)];
});
await stroke(cdpA, A, line(140, 240, 190, 380, 20), { pointerType: 'mouse' }); // 이동
const moved = await A.evaluate((ids) => ids.map((id) => window.__inknote.doc.object(id).pts[1]), sel.ids);
assert(moved.every((y) => y > 340), 'selection moved down');
// 우하단 핸들 드래그로 2배 확대
const box = await A.evaluate(() => {
  const ed = window.__inknote.editor;
  const objs = ed.state.selection.ids.map((id) => ed.doc.object(id));
  const xs = objs.flatMap((o) => o.pts.filter((_, i) => i % 3 === 0));
  const ys = objs.flatMap((o) => o.pts.filter((_, i) => i % 3 === 1));
  const pad = Math.max(...objs.map((o) => o.width));
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), pad };
});
const cx = box.maxX + box.pad / 2 + 1, cy = box.maxY + box.pad / 2 + 1;
await stroke(cdpA, A, line(cx, cy, cx + (box.maxX - box.minX), cy + (box.maxY - box.minY), 20), { pointerType: 'mouse' });
const bb1 = await A.evaluate((ids) => {
  const xs = ids.flatMap((id) => window.__inknote.doc.object(id).pts.filter((_, i) => i % 3 === 0));
  return [Math.min(...xs), Math.max(...xs)];
}, sel.ids);
const ratio = (bb1[1] - bb1[0]) / (bb0[1] - bb0[0]);
assert(ratio > 1.7 && ratio < 2.3, `selection scaled ~2x (${ratio.toFixed(2)})`);
await A.screenshot({ path: path.join(OUT, '03-lasso.png') });
const nBeforeDup = (await objsOf(A)).length;
await A.locator('.selection-menu').getByRole('button', { name: '복제' }).click();
assert((await objsOf(A)).length === nBeforeDup + 2, 'duplicate selection');
await A.locator('.selection-menu').getByRole('button', { name: '삭제' }).click();
assert((await objsOf(A)).length === nBeforeDup, 'delete selection');

// ───────────── 4. 웹 ↔ 다른 기기 동기화 ─────────────
await A.waitForFunction(() => window.__inknote.session.status === 'synced', null, { timeout: 5000 });
const docIdA = await A.evaluate(() => window.__inknote.doc.id);
const ctxB = await browser.newContext({ viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2, hasTouch: true });
const B = await ctxB.newPage();
B.on('pageerror', (e) => { pageErrors.push(String(e)); console.error('PAGEERROR B', e); });
const cdpB = await ctxB.newCDPSession(B);
await B.goto(URL0);
await B.getByText('클라우드').first().waitFor();
await B.getByRole('button', { name: /열기/ }).first().click();
await B.waitForFunction((n) => window.__inknote?.doc.pages.length === 1 && window.__inknote.doc.objects(window.__inknote.doc.pages[0].id).length === n, nBeforeDup, { timeout: 5000 });
assert((await B.evaluate(() => window.__inknote.doc.id)) === docIdA, 'device B opened same doc from server');
await B.waitForTimeout(400);
await B.screenshot({ path: path.join(OUT, '04-deviceB.png') });
await stroke(cdpB, B, cursive(100, 600, 300, 6, 20));
await A.waitForFunction((n) => window.__inknote.doc.objects(window.__inknote.doc.pages[0].id).length === n + 1, nBeforeDup, { timeout: 5000 });
log('OK device A received stroke drawn on device B');
// B 에서 테이프 토글 → A 반영
await B.evaluate(() => window.__inknote.editor.update({ tool: 'tape' }));
const tapeB = await toScreen(B, [[360, 126]]);
await B.mouse.click(tapeB[0][0], tapeB[0][1]);
await A.waitForFunction(() => window.__inknote.doc.objects(window.__inknote.doc.pages[0].id).find((o) => o.type === 'tape').revealed === false, null, { timeout: 5000 });
log('OK tape state synced B → A');

// ───────────── 4b. 손가락 제스처: 두 손가락 탭 = 실행 취소, 세 손가락 탭 = 다시 실행 (기기 B) ─────────────
async function fingerTap(cdp, p, n) {
  const pts = Array.from({ length: n }, (_, i) => ({ x: 500 + i * 60, y: 900, id: i }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts });
  await p.waitForTimeout(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForTimeout(150);
}
assert((await B.evaluate(() => window.__inknote.editor.state.penOnly)) === true, 'pen detected → fingers only scroll (palm rejection)');
await fingerTap(cdpB, B, 2);
const tapeIs = (v) => B.waitForFunction((v) => window.__inknote.doc.objects(window.__inknote.doc.pages[0].id).find((o) => o.type === 'tape').revealed === v, v, { timeout: 5000 }).then(() => true, () => false);
assert(await tapeIs(true), 'two-finger tap undoes last action');
await A.waitForFunction(() => window.__inknote.doc.objects(window.__inknote.doc.pages[0].id).find((o) => o.type === 'tape').revealed === true, null, { timeout: 5000 });
log('OK undo on device B propagated to device A');
await fingerTap(cdpB, B, 3);
assert(await tapeIs(false), 'three-finger tap redoes');

// ───────────── 5. PDF 가져오기 → 필기 → 내보내기 ─────────────
const src = await PDFDocument.create();
const font = await src.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 2; i++) {
  const pg = src.addPage([595, 842]);
  pg.drawText(`Lecture ${i}: Bezier curves`, { x: 60, y: 760, size: 26, font });
  for (let k = 0; k < 14; k++) pg.drawText(`Line ${k + 1}: B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3`, { x: 60, y: 700 - k * 30, size: 12, font, color: rgb(0.15, 0.15, 0.2) });
}
const srcPath = path.join(OUT, 'lecture.pdf');
fs.writeFileSync(srcPath, await src.save());

await A.getByTitle('라이브러리').click();
const [chooser] = await Promise.all([A.waitForEvent('filechooser'), A.getByRole('button', { name: /PDF 가져오기/ }).click()]);
await chooser.setFiles(srcPath);
await A.waitForFunction(() => window.__inknote?.doc.pages.length === 2 && window.__inknote.doc.pages[0].bg.kind === 'pdf', null, { timeout: 10000 });
await A.waitForTimeout(800);
await A.keyboard.press('h');
await stroke(cdpA, A, line(58, 82, 360, 82, 30), { pointerType: 'mouse' });
await A.keyboard.press('p');
await stroke(cdpA, A, [...line(60, 160, 200, 160, 30, 0.6)]);
await stroke(cdpA, A, cursive(400, 170, 150, 4, 18));
await A.keyboard.press('s');
await A.getByRole('button', { name: '사각형' }).click();
await stroke(cdpA, A, line(52, 220, 540, 258, 10), { pointerType: 'mouse' });
// 밑줄: "Line 3" 줄 아래를 대충, 약간 비뚤게 → 글자 기준선/단어 경계에 맞춰짐
// pdf-lib 좌표: baseline y = 700 - 2*30 = 640 (아래 원점) → 페이지 좌표 842 - 640 = 202
await A.keyboard.press('u');
await A.waitForTimeout(400);
await stroke(cdpA, A, line(72, 209, 175, 205, 20), { pointerType: 'mouse' });
const ul = await A.evaluate(() => {
  const d = window.__inknote.doc;
  return d.objects(d.pages[0].id).filter((o) => o.tool === 'underline').at(-1).pts;
});
log('underline snapped to', ul.map((v) => v.toFixed(1)).join(','));
assert(ul[1] === ul[4] && ul[1] > 202.3 && ul[1] < 205, `underline sits just under the PDF text baseline (y=${ul[1]})`);
assert(ul[0] > 58 && ul[0] < 63, `underline start snapped to word boundary (x0=${ul[0].toFixed(1)})`);
await A.waitForTimeout(500);
await A.screenshot({ path: path.join(OUT, '05-pdf-annotate.png') });

const [download] = await Promise.all([A.waitForEvent('download'), A.getByTitle('PDF로 내보내기').click()]);
const outPdf = path.join(OUT, 'exported.pdf');
await download.saveAs(outPdf);
const exported = await PDFDocument.load(fs.readFileSync(outPdf));
assert(exported.getPageCount() === 2, 'exported PDF has 2 pages');
const pdfAssetSynced = await fetch(`http://localhost:8787/api/blobs/${await A.evaluate(() => window.__inknote.doc.assets()[0].id)}`, { method: 'HEAD' });
assert(pdfAssetSynced.ok, 'PDF original uploaded to sync server');

// 내보낸 PDF 를 다시 가져와서 필기가 PDF 에 벡터로 포함됐는지 눈으로 확인
await A.getByTitle('라이브러리').click();
const [chooser2] = await Promise.all([A.waitForEvent('filechooser'), A.getByRole('button', { name: /PDF 가져오기/ }).click()]);
await chooser2.setFiles(outPdf);
await A.waitForFunction(() => window.__inknote?.doc.pages.length === 2 && window.__inknote.doc.objects(window.__inknote.doc.pages[0].id).length === 0, null, { timeout: 10000 });
await A.waitForTimeout(1200);
await A.screenshot({ path: path.join(OUT, '06-exported-reimported.png') });

// 확대 시 벡터 선명도
await A.evaluate(() => window.__inknote.editor.zoomAt(200, 200, 4));
await A.waitForTimeout(1200);
await A.screenshot({ path: path.join(OUT, '07-zoom.png') });

// ───────────── 7. 점진 렌더링 · 멈추면 직선 · 8개 핸들 · 붙여넣기 · 다크 모드 · 드래그 앤 드롭 ─────────────
await A.getByTitle('라이브러리').click();
await A.getByRole('button', { name: '새 노트', exact: true }).click();
await A.getByRole('button', { name: '무지' }).click();
await A.waitForFunction(() => window.__inknote?.editor?.rects.length === 1 && window.__inknote.doc.pages[0].bg.kind === 'blank');
await A.waitForTimeout(400);
const stats = () => A.evaluate(() => ({ ...window.__inknote.editor.stats }));
await A.keyboard.press('p');
let s0 = await stats();
await stroke(cdpA, A, cursive(80, 140, 200, 5));
await A.waitForTimeout(100);
let s1 = await stats();
assert(s1.inkFull === s0.inkFull && s1.incremental === s0.incremental + 1, `new stroke drawn incrementally, no full redraw (${JSON.stringify(s0)} → ${JSON.stringify(s1)})`);
await A.keyboard.press('h');
s0 = await stats();
await stroke(cdpA, A, line(75, 132, 290, 132, 30), { pointerType: 'mouse' });
await A.waitForTimeout(100);
s1 = await stats();
assert(s1.bgFull === s0.bgFull && s1.inkFull === s0.inkFull && s1.incremental === s0.incremental + 1, 'highlighter drawn incrementally under ink');

// 그리고 멈추면 직선
await A.keyboard.press('p');
{
  const pts = await toScreen(A, Array.from({ length: 40 }, (_, i) => [90 + i * 5, 260 + Math.sin(i * 0.9) * 4 + i * 0.08, 0.6]));
  const ev = (type, [x, y, f], buttons) => cdpA.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, force: f, pointerType: 'pen' });
  await ev('mousePressed', pts[0], 1);
  for (const q of pts.slice(1)) await ev('mouseMoved', q, 1);
  await A.waitForTimeout(800); // 멈춤
  await A.screenshot({ path: path.join(OUT, '09-hold-straight.png') });
  await ev('mouseReleased', pts.at(-1), 0);
  await A.waitForTimeout(50);
}
const straightPts = await A.evaluate(() => {
  const d = window.__inknote.doc;
  return d.objects(d.pages[0].id).at(-1).pts;
});
assert(straightPts.length === 6 && straightPts[1] === straightPts[4], `hold converts stroke to a horizontal straight line (${straightPts.map((v) => v.toFixed(1))})`);

// 올가미 → 오른쪽 변 핸들로 가로만 늘리기
await A.keyboard.press('l');
await stroke(cdpA, A, Array.from({ length: 61 }, (_, i) => {
  const a = (i / 60) * Math.PI * 2;
  return [180 + Math.cos(a) * 125, 128 + Math.sin(a) * 40, 0.5];
}), { pointerType: 'mouse' });
const selIds = await A.evaluate(() => window.__inknote.editor.state.selection?.ids ?? []);
assert(selIds.length === 2, `lasso selected pen + highlighter (${selIds.length})`);
const bboxOf = (ids) => A.evaluate((ids) => {
  const { objectBBox } = window.__inknoteCore ?? {};
  const xs = [], ys = [];
  for (const id of ids) {
    const o = window.__inknote.doc.object(id);
    for (let i = 0; i < o.pts.length; i += 3) { xs.push(o.pts[i]); ys.push(o.pts[i + 1]); }
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}, ids);
const e0 = await A.evaluate(() => {
  const ed = window.__inknote.editor;
  const objs = ed.state.selection.ids.map((id) => ed.doc.object(id));
  // 선택 상자(렌더 bbox) 오른쪽 변 중앙
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const o of objs) for (let i = 0; i < o.pts.length; i += 3) {
    const pad = (o.pts[i + 2] * o.width) / 2 + 1;
    minX = Math.min(minX, o.pts[i] - pad); maxX = Math.max(maxX, o.pts[i] + pad);
    minY = Math.min(minY, o.pts[i + 1] - pad); maxY = Math.max(maxY, o.pts[i + 1] + pad);
  }
  return { x: maxX, y: (minY + maxY) / 2 };
});
const before8 = await bboxOf(selIds);
await stroke(cdpA, A, line(e0.x, e0.y, e0.x + 110, e0.y + 30, 15), { pointerType: 'mouse' });
const after8 = await bboxOf(selIds);
const wr = (after8.maxX - after8.minX) / (before8.maxX - before8.minX);
const hr = (after8.maxY - after8.minY) / (before8.maxY - before8.minY);
assert(wr > 1.35 && Math.abs(hr - 1) < 0.02, `edge handle stretches width only (w×${wr.toFixed(2)}, h×${hr.toFixed(2)})`);
await A.screenshot({ path: path.join(OUT, '10-edge-handle.png') });

// 복사 → 붙여넣기 버튼
const nObj = (await objsOf(A)).length;
await A.locator('.selection-menu').getByRole('button', { name: '복사' }).click();
await A.getByRole('button', { name: /붙여넣기/ }).click();
assert((await objsOf(A)).length === nObj + 2, 'paste button inserts copied objects');

// 다크 모드
for (let i = 0; i < 3 && (await A.evaluate(() => document.documentElement.dataset.theme)) !== 'dark'; i++) {
  await A.getByRole('button', { name: /테마|모드/ }).first().click();
}
await A.waitForTimeout(300);
const desk = await A.evaluate(() => {
  const c = document.querySelector('.layer-bg');
  return [...c.getContext('2d').getImageData(4, 4, 1, 1).data];
});
assert(desk[0] < 40 && desk[1] < 40, `dark mode desk color (${desk})`);
await A.screenshot({ path: path.join(OUT, '11-dark.png') });

// 라이브러리에 PDF 끌어다 놓기
await A.getByTitle('라이브러리').click();
await A.waitForTimeout(300);
const b64 = fs.readFileSync(srcPath).toString('base64');
await A.evaluate((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], 'dropped.pdf', { type: 'application/pdf' }));
  document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, b64);
await A.waitForFunction(() => window.__inknote?.doc.meta.title === 'dropped' && window.__inknote.doc.pages.length === 2, null, { timeout: 10000 });
log('OK dropped PDF opened as a new note');
await A.waitForTimeout(800);
await A.screenshot({ path: path.join(OUT, '12-dropped-dark.png') });

await A.getByTitle('라이브러리').click();
await A.waitForTimeout(400);
await A.screenshot({ path: path.join(OUT, '08-library.png') });

// ───────────── 8. 굿노트 가져오기 (합성 파일, 한글 파일명으로 드래그 앤 드롭) ─────────────
const gnPath = path.join(OUT, 'sample.goodnotes');
execFileSync('npx', ['tsx', path.join(path.dirname(new URL(import.meta.url).pathname), 'make-goodnotes.ts'), gnPath]);
await A.evaluate(() => { location.hash = ''; });
await A.getByRole('button', { name: '새 노트', exact: true }).waitFor();
const gnB64 = fs.readFileSync(gnPath).toString('base64');
await A.evaluate((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], '내 굿노트.goodnotes', { type: '' }));
  document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, gnB64);
await A.locator('.import-report').waitFor({ timeout: 20000 });
const reportText = await A.locator('.import-report').innerText();
log('goodnotes report:', reportText.replace(/\n/g, ' | '));
assert(reportText.includes('내 굿노트') && reportText.includes('지운 획(제외) 1'), 'goodnotes import report (Korean file name, erased strokes skipped)');
await A.getByRole('button', { name: '열기', exact: true }).click();
await A.waitForFunction(() => window.__inknote?.doc.meta.title === '내 굿노트' && window.__inknote.editor.rects.length === 1);
const gn = await A.evaluate(() => {
  const d = window.__inknote.doc, p = d.pages[0], objs = d.objects(p.id);
  return { w: p.width, h: p.height, bg: p.bg.kind, types: objs.reduce((m, o) => ((m[o.type] = (m[o.type] || 0) + 1), m), {}),
    flow: objs.find((o) => o.type === 'text' && o.flow)?.text, box: objs.find((o) => o.type === 'text' && !o.flow)?.text,
    group: objs.filter((o) => o.group).length, assets: d.assets().map((a) => a.kind).sort() };
});
log('goodnotes page', JSON.stringify(gn));
assert(Math.abs(gn.w - 841.5) < 0.1 && gn.bg === 'pdf' && gn.types.image === 1 && gn.flow === 'Title' && gn.box === '한글 ABC' && gn.group === 1, 'paper size, template, image, page text, Korean text box, sticker group');
assert(JSON.stringify(gn.assets) === '["image","pdf"]', 'template PDF and image stored as assets');

// 텍스트 도구로 새 상자
await A.keyboard.press('x');
const [[gx, gy]] = await toScreen(A, [[60, 520]]);
await A.mouse.click(gx, gy);
await A.locator('.text-editor').waitFor();
await A.keyboard.type('E2E 텍스트');
await A.keyboard.press('Escape');
assert(await A.evaluate(() => { const d = window.__inknote.doc; return d.objects(d.pages[0].id).some((o) => o.type === 'text' && o.text === 'E2E 텍스트'); }), 'text tool creates a text box');

// 이미지 삽입 (브라우저에서 만든 PNG)
const png = Buffer.from(await A.evaluate(() => { const c = document.createElement('canvas'); c.width = 80; c.height = 40; const g = c.getContext('2d'); g.fillStyle = '#4a90e2'; g.fillRect(0, 0, 80, 40); return c.toDataURL('image/png').split(',')[1]; }), 'base64');
const [imgChooser] = await Promise.all([A.waitForEvent('filechooser'), A.getByTitle('이미지 삽입').click()]);
await imgChooser.setFiles({ name: 'blue.png', mimeType: 'image/png', buffer: png });
await A.waitForFunction(() => { const d = window.__inknote.doc; return d.objects(d.pages[0].id).filter((o) => o.type === 'image').length === 2; });
assert(true, 'insert image');
await A.waitForTimeout(600);
await A.screenshot({ path: path.join(OUT, '13-goodnotes-import.png') });
const [gnDl] = await Promise.all([A.waitForEvent('download'), A.getByTitle('PDF로 내보내기').click()]);
const gnPdf = await PDFDocument.load(fs.readFileSync(await gnDl.path()));
assert(gnPdf.getPageCount() === 1 && Math.abs(gnPdf.getPage(0).getSize().width - 841.5) < 1, 'export imported note to PDF at paper size');

await browser.close();
assert(pageErrors.length === 0, `no uncaught page errors (${pageErrors.length})`);
log('ALL E2E CHECKS PASSED');
