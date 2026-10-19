import type { JSX } from 'react';
import { PALETTE, TOOL_PRESETS, type EraserMode, type InkTool, type ShapeKind } from '@inknote/core';
import type { Editor } from '../engine/Editor';
import type { EditorUIState, ToolId } from '../engine/types';
import { Icon } from './icons';

const TOOLS: Array<{ id: ToolId; label: string; icon: () => JSX.Element; key: string }> = [
  { id: 'pen', label: '만년필', icon: Icon.pen, key: 'P' },
  { id: 'pencil', label: '연필', icon: Icon.pencil, key: 'N' },
  { id: 'ballpoint', label: '볼펜 (필압 없음)', icon: Icon.ballpoint, key: 'B' },
  { id: 'marker', label: '마카', icon: Icon.marker, key: 'M' },
  { id: 'highlighter', label: '형광펜', icon: Icon.highlighter, key: 'H' },
  { id: 'underline', label: '밑줄', icon: Icon.underline, key: 'U' },
  { id: 'eraser', label: '지우개', icon: Icon.eraser, key: 'E' },
  { id: 'lasso', label: '올가미', icon: Icon.lasso, key: 'L' },
  { id: 'shape', label: '도형', icon: Icon.shape, key: 'S' },
  { id: 'tape', label: '암기 테이프', icon: Icon.tape, key: 'T' },
  { id: 'text', label: '텍스트', icon: Icon.text, key: 'X' },
];

const INK = new Set<ToolId>(['pen', 'pencil', 'ballpoint', 'marker', 'highlighter', 'underline']);

export function ToolButtons({ editor, st }: { editor: Editor; st: EditorUIState }) {
  return (
    <div className="tool-group">
      {TOOLS.map((t) => {
        const color = INK.has(t.id) ? st.inkStyles[t.id as InkTool].color : t.id === 'shape' ? st.shapeStyle.color : t.id === 'tape' ? st.tapeStyle.color : undefined;
        return (
          <button
            key={t.id}
            className={`icon-btn tool ${st.tool === t.id ? 'active' : ''}`}
            title={`${t.label} (${t.key})`}
            aria-label={t.label}
            aria-pressed={st.tool === t.id}
            onClick={() => editor.update({ tool: t.id })}
          >
            <t.icon />
            {color && <span className="tool-dot" style={{ background: color }} />}
          </button>
        );
      })}
      <span className="divider" />
      <button
        className={`icon-btn ${st.ruler ? 'active' : ''}`}
        title="자 (펜을 자 가장자리 근처에서 그으면 직선)"
        aria-pressed={st.ruler}
        onClick={() => editor.update({ ruler: !st.ruler })}
      >
        <Icon.ruler />
      </button>
    </div>
  );
}

function Swatches({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className="swatches">
      {PALETTE.map((c) => (
        <button key={c} className={`swatch ${c === value ? 'active' : ''}`} style={{ background: c }} aria-label={c} onClick={() => onPick(c)} />
      ))}
      <label className="swatch custom" title="사용자 색상">
        <input type="color" value={value} onChange={(e) => onPick(e.target.value)} />
      </label>
    </div>
  );
}

function Widths({ values, value, onPick, color }: { values: number[]; value: number; onPick: (w: number) => void; color: string }) {
  const max = Math.max(...values);
  return (
    <div className="widths">
      {values.map((w) => (
        <button key={w} className={`width-btn ${Math.abs(w - value) < 1e-6 ? 'active' : ''}`} onClick={() => onPick(w)} title={`${w}pt`}>
          <span style={{ width: 4 + (w / max) * 16, height: 4 + (w / max) * 16, background: color }} />
        </button>
      ))}
    </div>
  );
}

function Seg<T extends string>({ items, value, onPick }: { items: Array<[T, string]>; value: T; onPick: (v: T) => void }) {
  return (
    <div className="seg">
      {items.map(([v, label]) => (
        <button key={v} className={v === value ? 'active' : ''} onClick={() => onPick(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** 선택된 도구의 세부 옵션 (색/굵기/모드) */
export function ToolOptions({ editor, st }: { editor: Editor; st: EditorUIState }) {
  const t = st.tool;
  if (INK.has(t)) {
    const tool = t as InkTool;
    const style = st.inkStyles[tool];
    const preset = TOOL_PRESETS[tool];
    return (
      <div className="options">
        <span className="opt-label">{preset.label}</span>
        <Swatches value={style.color} onPick={(color) => editor.setInkStyle(tool, { color })} />
        <Widths values={preset.widths} value={style.width} color={style.color} onPick={(width) => editor.setInkStyle(tool, { width })} />
        {preset.variable && <span className="hint">필압·속도 반영</span>}
      </div>
    );
  }
  if (t === 'eraser') {
    return (
      <div className="options">
        <Seg<EraserMode>
          items={[['stroke', '획 지우개'], ['partial', '부분 지우개'], ['highlighter', '형광펜만']]}
          value={st.eraserMode}
          onPick={(eraserMode) => editor.update({ eraserMode })}
        />
        <Widths values={[12, 24, 44]} value={st.eraserSize} color="#555" onPick={(eraserSize) => editor.update({ eraserSize })} />
      </div>
    );
  }
  if (t === 'shape') {
    return (
      <div className="options">
        <Seg<ShapeKind>
          items={[['line', '직선'], ['arrow', '화살표'], ['rect', '사각형'], ['ellipse', '원']]}
          value={st.shapeKind}
          onPick={(shapeKind) => editor.update({ shapeKind })}
        />
        <Swatches value={st.shapeStyle.color} onPick={(color) => editor.update({ shapeStyle: { ...st.shapeStyle, color } })} />
        <Widths values={[1, 1.8, 3]} value={st.shapeStyle.width} color={st.shapeStyle.color} onPick={(width) => editor.update({ shapeStyle: { ...st.shapeStyle, width } })} />
        <span className="hint">Shift: 정사각형/정원, 15° 스냅</span>
      </div>
    );
  }
  if (t === 'tape') {
    return (
      <div className="options">
        <Swatches value={st.tapeStyle.color} onPick={(color) => editor.update({ tapeStyle: { ...st.tapeStyle, color } })} />
        <Widths values={[10, 16, 24]} value={st.tapeStyle.width} color={st.tapeStyle.color} onPick={(width) => editor.update({ tapeStyle: { ...st.tapeStyle, width } })} />
        <button className="text-btn" onClick={() => editor.setAllTapes(true)}><Icon.eye /> 모두 보기</button>
        <button className="text-btn" onClick={() => editor.setAllTapes(false)}><Icon.eyeOff /> 모두 가리기</button>
        <span className="hint">단어 위로 드래그해서 붙이고, 탭하면 가림/보임</span>
      </div>
    );
  }
  if (t === 'text') {
    const ts = st.textStyle;
    return (
      <div className="options">
        <Swatches value={ts.color} onPick={(color) => editor.update({ textStyle: { ...ts, color } })} />
        <Seg<string>
          items={[['12', '작게'], ['16', '보통'], ['24', '크게'], ['34', '제목']]}
          value={String(ts.size)}
          onPick={(v) => editor.update({ textStyle: { ...ts, size: +v } })}
        />
        <span className="hint">빈 곳을 탭하면 새 텍스트 상자, 글자를 탭하면 수정</span>
      </div>
    );
  }
  if (t === 'lasso') {
    return (
      <div className="options">
        {st.clipboardCount > 0 && (
          <button className="text-btn" onClick={() => editor.paste()}><Icon.paste /> 붙여넣기 ({st.clipboardCount})</button>
        )}
        <span className="hint">둘러싸서 선택 · 드래그로 이동 · 모서리(비율 유지)/변(한 방향) 핸들로 크기 조절</span>
      </div>
    );
  }
  return null;
}

/** 올가미 선택 시 떠 있는 메뉴 */
export function SelectionMenu({ editor, st, onSaveSticker }: { editor: Editor; st: EditorUIState; onSaveSticker?: () => void }) {
  if (!st.selection) return null;
  return (
    <div className="selection-menu" role="toolbar" aria-label="선택 항목">
      <span className="sel-count">{st.selection.ids.length}개 선택</span>
      <div className="swatches small">
        {PALETTE.slice(0, 8).map((c) => (
          <button key={c} className="swatch" style={{ background: c }} aria-label={`색 ${c}`} onClick={() => editor.recolorSelection(c)} />
        ))}
      </div>
      <button className="text-btn" onClick={() => editor.duplicateSelection()}><Icon.copy /> 복제</button>
      <button className="text-btn" onClick={() => editor.copySelection()}>복사</button>
      {onSaveSticker && <button className="text-btn" onClick={onSaveSticker} title="내 스티커에 저장"><Icon.sticker /> 스티커로</button>}
      <button className="text-btn danger" onClick={() => editor.deleteSelection()}><Icon.trash /> 삭제</button>
    </div>
  );
}
