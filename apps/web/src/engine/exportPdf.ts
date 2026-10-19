import {
  BlendMode, LineCapStyle, LineJoinStyle, PDFDocument, concatTransformationMatrix, popGraphicsState,
  pushGraphicsState, rgb, setLineJoin, type PDFImage, type PDFPage,
} from 'pdf-lib';
import {
  SvgPathBuilder, TOOL_PRESETS, buildOutline, traceCenterline, traceOutline, traceShape, traceTape,
  type ImageObj, type InkDocument, type InkObject, type Page, type TextObj,
} from '@inknote/core';
import { drawText } from './render';

const hex = (c: string) => rgb(parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255);

export interface ExportSources {
  getBlob(id: string): Promise<ArrayBuffer | null>;
  /** 이미지 에셋의 mime (jpeg/png 은 그대로, 나머지는 PNG 로 변환해 넣음) */
  mimeOf(id: string): string | undefined;
}

/**
 * 뷰 좌표(좌상단 원점, y↓, 회전 적용된 화면 기준) → PDF 사용자 공간 변환 행렬.
 * drawSvgPath 가 내부적으로 y 를 뒤집으므로 (vx, -vy) 를 입력으로 받는 행렬을 만든다.
 */
function viewMatrix(rotation: number, bx: number, by: number, W: number, H: number): [number, number, number, number, number, number] {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [0, 1, -1, 0, bx, by];
    case 180:
      return [-1, 0, 0, -1, bx + W, by];
    case 270:
      return [0, -1, 1, 0, bx + W, by + H];
    default:
      return [1, 0, 0, 1, bx, by + H];
  }
}

function drawPaperLines(pdfPage: PDFPage, page: Page): void {
  if (page.bg.kind === 'pdf' || page.bg.kind === 'blank') return;
  const b = new SvgPathBuilder();
  const color = page.bg.kind === 'lined' ? hex('#b9d3ee') : hex('#d7e3ef');
  if (page.bg.kind === 'lined') {
    for (let y = 72; y < page.height - 24; y += 24) {
      b.moveTo(28, y);
      b.lineTo(page.width - 28, y);
    }
  } else if (page.bg.kind === 'grid') {
    for (let x = 18; x < page.width; x += 18) {
      b.moveTo(x, 0);
      b.lineTo(x, page.height);
    }
    for (let y = 18; y < page.height; y += 18) {
      b.moveTo(0, y);
      b.lineTo(page.width, y);
    }
  } else {
    for (let x = 18; x < page.width; x += 18) for (let y = 18; y < page.height; y += 18) {
      b.moveTo(x, y);
      b.lineTo(x + 0.01, y);
    }
  }
  pdfPage.drawSvgPath(b.toString(), { x: 0, y: 0, borderColor: color, borderWidth: page.bg.kind === 'dotted' ? 1.6 : 0.5, borderLineCap: LineCapStyle.Round });
}

/** 텍스트 상자 → 3배 해상도 PNG (한글 글꼴을 PDF 에 넣지 않고도 그대로 보이게) */
async function textToPng(o: TextObj): Promise<Uint8Array> {
  const k = 3;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(o.w * k));
  c.height = Math.max(1, Math.ceil(o.h * k));
  const ctx = c.getContext('2d')!;
  ctx.scale(k, k);
  drawText(ctx, { ...o, x: 0, y: 0 });
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** jpeg/png 외 형식(webp, gif, heic…)은 브라우저로 디코딩해 PNG 로 변환 */
async function toPng(bytes: ArrayBuffer, mime: string): Promise<Uint8Array | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 노트 → PDF. 원본 PDF 페이지는 그대로 복사(텍스트·벡터 보존)하고,
 * 필기는 래스터가 아닌 PDF 벡터 경로로 그 위에 기록한다. 이미지는 원본 그대로 넣는다.
 */
export async function exportPdf(doc: InkDocument, src: ExportSources): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setTitle(doc.meta.title);
  out.setProducer('InkNote');
  const sources = new Map<string, PDFDocument | null>();
  const images = new Map<string, PDFImage | null>();

  const embedImage = async (o: ImageObj): Promise<PDFImage | null> => {
    if (images.has(o.assetId)) return images.get(o.assetId)!;
    const bytes = await src.getBlob(o.assetId);
    let img: PDFImage | null = null;
    if (bytes) {
      const mime = src.mimeOf(o.assetId) ?? '';
      try {
        if (mime === 'image/jpeg') img = await out.embedJpg(bytes);
        else if (mime === 'image/png') img = await out.embedPng(bytes);
        else {
          const png = await toPng(bytes, mime);
          if (png) img = await out.embedPng(png);
        }
      } catch {
        img = null;
      }
    }
    images.set(o.assetId, img);
    return img;
  };

  const drawObj = async (pdfPage: PDFPage, o: InkObject) => {
    const b = new SvgPathBuilder();
    switch (o.type) {
      case 'stroke': {
        const preset = TOOL_PRESETS[o.tool];
        const blendMode = preset.blend === 'multiply' ? BlendMode.Multiply : undefined;
        if (preset.variable) {
          traceOutline(b, buildOutline(o.pts, o.width));
          pdfPage.drawSvgPath(b.toString(), { x: 0, y: 0, color: hex(o.color), opacity: o.opacity, blendMode });
        } else {
          traceCenterline(b, o.pts);
          pdfPage.drawSvgPath(b.toString(), {
            x: 0, y: 0, borderColor: hex(o.color), borderWidth: o.width, borderOpacity: o.opacity,
            borderLineCap: preset.cap === 'round' ? LineCapStyle.Round : LineCapStyle.Butt, blendMode,
          });
        }
        break;
      }
      case 'shape':
        traceShape(b, o);
        pdfPage.drawSvgPath(b.toString(), { x: 0, y: 0, borderColor: hex(o.color), borderWidth: o.width, borderOpacity: o.opacity, borderLineCap: LineCapStyle.Round });
        break;
      case 'tape':
        traceTape(b, o);
        pdfPage.drawSvgPath(b.toString(), { x: 0, y: 0, color: hex(o.color), opacity: o.revealed ? 0.22 : 1 });
        break;
      case 'image': {
        const img = await embedImage(o);
        // 현재 좌표계는 (x, -y) 이므로 아래쪽 모서리 -(y+h) 에서 위로 h 만큼
        if (img) pdfPage.drawImage(img, { x: o.x, y: -(o.y + o.h), width: o.w, height: o.h, opacity: o.opacity });
        break;
      }
      case 'text': {
        if (!o.text.trim()) break;
        const png = await out.embedPng(await textToPng(o));
        pdfPage.drawImage(png, { x: o.x, y: -(o.y + o.h), width: o.w, height: o.h });
        break;
      }
    }
  };

  for (const page of doc.pages) {
    let pdfPage: PDFPage | null = null;
    let m = viewMatrix(0, 0, 0, page.width, page.height);
    if (page.bg.kind === 'pdf') {
      const { assetId, pageIndex } = page.bg;
      if (!sources.has(assetId)) {
        const bytes = await src.getBlob(assetId);
        sources.set(assetId, bytes ? await PDFDocument.load(bytes, { ignoreEncryption: true }) : null);
      }
      const s = sources.get(assetId);
      if (s && pageIndex < s.getPageCount()) {
        const sp = s.getPage(pageIndex);
        const rot = ((sp.getRotation().angle % 360) + 360) % 360;
        const { width: sw, height: sh } = sp.getSize();
        const [vw, vh] = rot % 180 ? [sh, sw] : [sw, sh];
        if (Math.abs(vw - page.width) < 1 && Math.abs(vh - page.height) < 1) {
          // 같은 크기: 페이지를 그대로 복사 (텍스트 선택·검색 유지)
          const [copied] = await out.copyPages(s, [pageIndex]);
          pdfPage = out.addPage(copied);
          const crop = pdfPage.getCropBox();
          m = viewMatrix(pdfPage.getRotation().angle, crop.x, crop.y, crop.width, crop.height);
        } else {
          // 크기가 다름 (굿노트 템플릿처럼 용지에 맞춰 늘린 배경): 늘려서 그림
          const [emb] = await out.embedPdf(s, [pageIndex]);
          pdfPage = out.addPage([page.width, page.height]);
          pdfPage.drawPage(emb, { x: 0, y: 0, width: page.width, height: page.height });
        }
      }
    }
    if (!pdfPage) {
      pdfPage = out.addPage([page.width, page.height]);
      pdfPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));
      drawPaperLines(pdfPage, page);
      pdfPage.pushOperators(popGraphicsState());
    }

    pdfPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), setLineJoin(LineJoinStyle.Round));
    const objs = doc.objects(page.id);
    for (const o of objs) if (o.type === 'stroke' && o.tool === 'highlighter') await drawObj(pdfPage, o);
    for (const o of objs) if (o.type !== 'tape' && !(o.type === 'stroke' && o.tool === 'highlighter')) await drawObj(pdfPage, o);
    for (const o of objs) if (o.type === 'tape') await drawObj(pdfPage, o);
    pdfPage.pushOperators(popGraphicsState());
  }
  return out.save();
}
