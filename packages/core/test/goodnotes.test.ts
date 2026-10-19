import { describe, expect, it } from 'vitest';
import { GN_TO_PT, appleLz4, convertGoodnotes, lz4Block, readTpl, rtfToText, type GnObject } from '../src';

import { RTF_KO_TEXT, RTF_TITLE, SIG_PEN, penTpl, sampleFiles } from './fixtures/goodnotes';

const byType = (objs: GnObject[], t: GnObject['type']) => objs.filter((o) => o.type === t);

describe('goodnotes low-level decoders', () => {
  it('decodes an LZ4 block with overlapping match', () => {
    const src = new Uint8Array([0x44, 97, 98, 99, 100, 0x04, 0x00, 0x10, 120]); // "abcd" + 8바이트 복사 + "x"
    expect(new TextDecoder().decode(lz4Block(src, 13))).toBe('abcdabcdabcdx');
  });

  it('reads Apple-framed blocks and tpl signatures exactly', () => {
    const t = readTpl(appleLz4(penTpl(1, 2, 0.5, 3, 4, 5, 6, 0.7)));
    expect(t.signature).toBe(SIG_PEN);
    expect(t.values[2]).toEqual([1, 2, 0.5]);
  });

  it('decodes Korean RTF (CP949) with font switching', () => {
    const r = rtfToText(RTF_KO_TEXT);
    expect(r.text).toBe('한글 ABC');
    expect(r.fontSize).toBe(24);
    expect(r.color).toBe('#000000');
    expect(rtfToText(RTF_TITLE)).toMatchObject({ text: 'Title', bold: true, fontSize: 34 });
  });
});

describe('convertGoodnotes', () => {
  const r = convertGoodnotes(sampleFiles());
  const page = r.pages[0];

  it('reads title, paper size and template', () => {
    expect(r.title).toBe('샘플 노트');
    expect(page.width).toBeCloseTo(1122 * GN_TO_PT);
    expect(page.height).toBeCloseTo(1452 * GN_TO_PT);
    expect(page.bg).toEqual({ kind: 'pdf', assetId: 'ATT-TPL', pageIndex: 0 });
    expect(r.attachments.get('ATT-TPL')?.mime).toBe('application/pdf');
    expect(r.attachments.get('ATT-IMG')?.mime).toBe('image/jpeg');
  });

  it('converts pen strokes with variable width and skips erased strokes', () => {
    const pens = page.objects.filter((o) => o.type === 'stroke' && o.tool === 'pen');
    expect(pens).toHaveLength(1);
    const p = pens[0] as Extract<GnObject, { type: 'stroke' }>;
    expect(p.pts[0]).toBeCloseTo(100 * GN_TO_PT);
    expect(p.width).toBeCloseTo(0.8 * GN_TO_PT);
    expect(p.pts[2]).toBeCloseTo(0.5); // 0.4 / 0.8
    expect(r.stats['지운 획(제외)']).toBe(1);
  });

  it('keeps highlighters, applies sticker offsets and groups', () => {
    const hl = page.objects.find((o) => o.type === 'stroke' && o.tool === 'highlighter') as Extract<GnObject, { type: 'stroke' }>;
    expect(hl.width).toBeCloseTo(20 * GN_TO_PT);
    const sticker = page.objects.find((o) => 'group' in o && o.group === 'GROUP-1') as Extract<GnObject, { type: 'stroke' }>;
    expect(sticker.pts[0]).toBeCloseTo(500 * GN_TO_PT); // 0 + 오프셋 500
    expect(sticker.pts[1]).toBeCloseTo(600 * GN_TO_PT);
  });

  it('converts rectangles (center+size) and polylines', () => {
    const rect = byType(page.objects, 'shape')[0] as Extract<GnObject, { type: 'shape' }>;
    expect(rect).toMatchObject({ shape: 'rect', color: '#ff0000' });
    expect(rect.x1).toBeCloseTo(250 * GN_TO_PT);
    expect(rect.y2).toBeCloseTo(225 * GN_TO_PT);
    const tri = page.objects.filter((o) => o.type === 'stroke' && o.tool === 'ballpoint' && !('group' in o && o.group));
    expect(tri.length).toBeGreaterThan(0);
  });

  it('converts text boxes, page text and images', () => {
    const texts = byType(page.objects, 'text') as Extract<GnObject, { type: 'text' }>[];
    const flow = texts.find((t) => t.flow)!;
    expect(flow).toMatchObject({ text: 'Title', bold: true });
    expect(flow.w).toBeCloseTo((1122 - 100) * GN_TO_PT);
    expect(page.objects[0]).toBe(flow); // 페이지 텍스트는 맨 아래
    const box = texts.find((t) => !t.flow)!;
    expect(box).toMatchObject({ text: '한글 ABC', fontSize: 24 * GN_TO_PT });
    expect(box.x).toBeCloseTo(410 * GN_TO_PT);
    const img = byType(page.objects, 'image')[0] as Extract<GnObject, { type: 'image' }>;
    expect(img).toMatchObject({ assetId: 'ATT-IMG' });
    expect(img.w).toBeCloseTo(200 * GN_TO_PT);
  });

  it('orders objects by GoodNotes z-order', () => {
    const imgIdx = page.objects.findIndex((o) => o.type === 'image');
    const penIdx = page.objects.findIndex((o) => o.type === 'stroke' && o.tool === 'pen');
    expect(imgIdx).toBeLessThan(penIdx); // 이미지 z=4 < 펜 z=5
  });

  it('falls back to A4 when the file has no paper info', () => {
    const r2 = convertGoodnotes(sampleFiles(false));
    expect(r2.pages[0].width).toBeCloseTo(595.28, 0);
    expect(r2.pages[0].bg.kind).toBe('blank');
    expect(r2.warnings.join()).toContain('A4');
  });

  it('rejects non-GoodNotes archives', () => {
    expect(() => convertGoodnotes(new Map())).toThrow();
  });
});
