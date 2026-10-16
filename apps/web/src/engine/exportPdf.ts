import {
  BlendMode, LineCapStyle, LineJoinStyle, PDFDocument, concatTransformationMatrix, popGraphicsState,
  pushGraphicsState, rgb, setLineJoin, type PDFPage,
} from 'pdf-lib';
import {
  SvgPathBuilder, TOOL_PRESETS, buildOutline, traceCenterline, traceOutline, traceShape, traceTape,
  type InkDocument, type InkObject, type Page,
} from '@inknote/core';

const hex = (c: string) => rgb(parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255);

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

function drawObject(pdfPage: PDFPage, o: InkObject): void {
  const b = new SvgPathBuilder();
  if (o.type === 'stroke') {
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
  } else if (o.type === 'shape') {
    traceShape(b, o);
    pdfPage.drawSvgPath(b.toString(), { x: 0, y: 0, borderColor: hex(o.color), borderWidth: o.width, borderOpacity: o.opacity, borderLineCap: LineCapStyle.Round });
  } else {
    traceTape(b, o);
    pdfPage.drawSvgPath(b.toString(), { x: 0, y: 0, color: hex(o.color), opacity: o.revealed ? 0.22 : 1 });
  }
}

/**
 * 노트 → PDF. 원본 PDF 페이지는 그대로 복사(텍스트·벡터 보존)하고,
 * 필기는 래스터가 아닌 PDF 벡터 경로로 그 위에 기록한다.
 */
export async function exportPdf(doc: InkDocument, getBlob: (id: string) => Promise<ArrayBuffer | null>): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setTitle(doc.meta.title);
  out.setProducer('InkNote');
  const sources = new Map<string, PDFDocument | null>();

  for (const page of doc.pages) {
    let pdfPage: PDFPage | null = null;
    let m = viewMatrix(0, 0, 0, page.width, page.height);
    if (page.bg.kind === 'pdf') {
      const { assetId, pageIndex } = page.bg;
      if (!sources.has(assetId)) {
        const bytes = await getBlob(assetId);
        sources.set(assetId, bytes ? await PDFDocument.load(bytes, { ignoreEncryption: true }) : null);
      }
      const src = sources.get(assetId);
      if (src) {
        const [copied] = await out.copyPages(src, [pageIndex]);
        pdfPage = out.addPage(copied);
        const crop = pdfPage.getCropBox();
        m = viewMatrix(pdfPage.getRotation().angle, crop.x, crop.y, crop.width, crop.height);
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
    for (const o of objs) if (o.type === 'stroke' && o.tool === 'highlighter') drawObject(pdfPage, o);
    for (const o of objs) if ((o.type === 'stroke' && o.tool !== 'highlighter') || o.type === 'shape') drawObject(pdfPage, o);
    for (const o of objs) if (o.type === 'tape') drawObject(pdfPage, o);
    pdfPage.pushOperators(popGraphicsState());
  }
  return out.save();
}
