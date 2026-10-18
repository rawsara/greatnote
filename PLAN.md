# InkNote — 설계 및 구현 플랜

GoodNotes 스타일의 디지털 필기 + PDF 주석 앱. **웹 · iOS · Android** 가 하나의 코드베이스와 하나의 동기화 서버를 공유한다.

---

## 1. 플랫폼 전략

| 선택지 | 장점 | 단점 | 결정 |
|---|---|---|---|
| **TS 코어 + Web(Canvas) + Capacitor 네이티브 셸** | 코드 100% 공유, 웹 즉시 배포, PDF/IndexedDB/WebSocket 그대로 사용 | WebView 입력 지연이 네이티브보다 약간 큼 | ✅ **채택** |
| React Native + Skia | 네이티브 렌더링 | 웹 버전 별도 구현, PDF 렌더링 네이티브 모듈 필요 | 보류 |
| Flutter | 단일 코드베이스 | 웹 Canvas 성능·PDF 생태계 약함, TS 코어 재사용 불가 | 보류 |

핵심은 **플랫폼 독립 코어(`@inknote/core`)** 다. 데이터 모델·곡선 보정·굵기 모델·지우개·올가미·CRDT 가 DOM 없이 순수 TS 로 구현되어
웹/앱 클라이언트와 Node 서버가 같은 코드를 쓴다. 나중에 iOS 를 PencilKit/Metal 로 네이티브화하더라도 코어 로직(동기화 포맷 포함)은 그대로 유지된다.

```
┌───────────────────────── apps/web (React + Canvas2D) ─────────────────────────┐
│  UI(툴바·사이드바)   Editor(입력·뷰포트·레이어)   PdfManager(pdf.js)   exportPdf(pdf-lib) │
│  Repo(IndexedDB)     DocSession(오프라인 outbox + WebSocket)                      │
└───────────────┬───────────────────────────────────────────────┬───────────────┘
                │ 같은 빌드를 Capacitor 로 감쌈                     │ ws:// /sync, /api/blobs
      ┌─────────┴─────────┐                              ┌──────────┴──────────┐
      │ iOS (WKWebView)    │                              │ apps/server (Node)   │
      │ Android (WebView)  │                              │ LWW 상태 + seq, PDF blob │
      └────────────────────┘                              └─────────────────────┘
                       모두 @inknote/core 를 공유
```

---

## 2. 벡터 데이터 구조

모든 필기·도형은 **이미지가 아닌 객체**로 저장한다. 좌표 단위는 PDF 포인트(1/72 inch), 페이지 좌상단 원점.
→ 줌과 무관하게 선명하고, PDF 내보내기 때 좌표 변환 없이 그대로 벡터 경로가 된다.

```ts
StrokeObj { type:'stroke', id, pageId, z, tool, color, width, opacity,
            pts: [x, y, w,  x, y, w, ...] }   // w = 필압·속도로 계산된 굵기 비율
ShapeObj  { type:'shape', shape:'line'|'arrow'|'rect'|'ellipse', x1,y1,x2,y2, color, width }
TapeObj   { type:'tape',  x1,y1,x2,y2, thickness, color, revealed }
Page      { id, order(fractional index), width, height, bg: 무지|줄|모눈|점 | {pdf, assetId, pageIndex} }
PdfAsset  { id: SHA-256, name, pageCount, size }
```

설계 포인트
- **굵기 비율 `w` 를 포인트마다 저장**: 원시 필압 대신 "계산 결과"를 저장하므로 모든 기기에서 동일하게 재현되고, 렌더링 시 재계산이 없다. 기준 굵기(`width`)만 바꾸면 비율이 유지된 채 굵기 변경 가능.
- **flat number 배열 + 양자화**(0.01pt / 0.001) + **RDP 단순화**(x, y, w 3차원) → 저장/전송 용량 최소화.
- **불변 객체**: 이동/크기 조절은 같은 id 로 새 객체를 put. 렌더 캐시(Path2D)·bbox 캐시를 `WeakMap` 으로 안전하게 둘 수 있다.
- **공간 인덱스(SpatialGrid)**: 페이지별 균일 격자. 지우개·올가미·화면 컬링에서 후보 객체만 조회.
- **z-order = Lamport 시계** → 기기 간에도 "나중에 그린 것이 위" 가 보장됨.

---

## 3. 손글씨 입력 파이프라인 (반응속도)

```
PointerEvent ─ getCoalescedEvents() (최대 240Hz 샘플 전부 사용)
   → One Euro Filter (화면 px, 느릴 땐 강하게/빠를 땐 약하게 보정, 인과적이라 펜 뗄 때 모양이 튀지 않음)
   → 0.5px 미만 이동 제거
   → WidthEstimator: ratio = 필압곡선(gamma) × (1 − 속도 얇아짐) × taper, EMA 평활화
   → 페이지 좌표 변환 (+ 자 스냅 / 밑줄 직선화)
   → overlay 캔버스에 즉시 렌더 (+ getPredictedEvents() 로 예측 꼬리)
펜 뗌 → 끝 taper → RDP → 양자화 → doc.transact() → base 레이어 반영
```

지연을 줄이는 장치
1. **4-레이어 캔버스** (아래→위)
   - `bg`: 책상·속지/PDF·**형광펜**(multiply 로 PDF 글자와 섞여 글씨를 가리지 않음)
   - `ink`: 확정된 펜 획·도형·테이프
   - `live`: 지금 그리는 획만 — 매 입력마다 이것만 다시 그리므로 문서 크기와 무관하게 일정한 비용
   - `ui`: 자·올가미·선택 핸들·지우개 커서·길이 표시 (포인터 이벤트 수신)
   - **새 획은 덧그리기**: 펜을 떼면 새 객체만 `ink`(형광펜은 `bg`)에 그린다. 전체 다시 그리기는 스크롤·줌·삭제·원격 변경처럼 기존 내용이 바뀔 때만 (`ChangeEvent.fresh` 로 판별)
2. **`desynchronized: true` 저지연 캔버스**: 지원 시 입력 이벤트 핸들러 안에서 바로 그려 컴포지터 대기를 건너뜀.
3. **coalesced + predicted events**: 샘플 손실 없이 부드럽고, 예측 포인트로 체감 지연 감소(커밋엔 미포함).
4. **펜 뗀 획 1프레임 유지(lingering)**: base 갱신 프레임까지 overlay 에 남겨 깜빡임 제거.
5. **팜 리젝션**: 펜 감지 시 손가락은 스크롤/줌 전용, 펜 획 중 터치 무시. 두 손가락 탭 = 실행 취소.

## 4. 베지에 곡선 보정

- **중심선**: 입력점을 모두 지나는 **centripetal Catmull-Rom(α=0.5)** 을 세그먼트마다 **3차 베지에로 변환**해 그린다. centripetal 매개화라 점 간격이 불균일하거나 급히 꺾여도 overshoot·cusp 가 생기지 않는다. 양 끝은 반사 가상점으로 접선을 만든다.
- **굵기**: `필압 곡선(gamma) × 속도 계수 × taper`. 시작·끝은 항상 가늘게(필압 입력은 짧게), 필압이 없는 마우스/손가락은 **속도로 필압을 추정**(느릴수록 굵게). 끝 taper 를 라이브 미리보기에도 적용해 펜을 뗄 때 모양이 바뀌지 않는다.
- **가변 굵기(만년필·연필)**: 베지에를 세그먼트 길이에 비례해 샘플링 → 각 샘플의 법선 방향 ±반폭 오프셋 → 반원 캡 → 외곽 폴리곤을 **중점 기준 2차 베지에**로 채움.
- **일정 굵기(볼펜·마카·형광펜·밑줄)**: 베지에 중심선을 `lineWidth` 로 stroke (더 가볍고 매끄러움).
- 같은 경로 생성 코드가 Canvas(Path2D)와 SVG 문자열(PDF 내보내기)에 공통 사용된다 (`PathSink` 인터페이스).

## 5. 도구

| 도구 | 렌더링 | 특징 |
|---|---|---|
| 만년필 | 가변 외곽선 | 필압 85% + 속도 35% 반영, 필압 없을 때 시작/끝 taper |
| 연필 | 가변 외곽선 + 흑연 질감 패턴 | 약한 필압, 결 방향 줄무늬·금속광 |
| 볼펜(필압 없음) | 일정 굵기 | |
| 마카 | 일정 굵기, 굵음 | |
| 형광펜 | 일정 굵기, multiply, **잉크 아래 레이어** | 라이브 미리보기도 CSS mix-blend-mode 로 multiply |
| 밑줄 | 시작→끝 직선 | **PDF 글자 줄 인식**: pdf.js 텍스트 → 기준선별 줄·단어 → 기준선 바로 아래로, 걸친 단어 경계로 길이 자동 맞춤. 줄노트는 가로줄에, 그 외 ±8° 수평 스냅 |
| 자 | 화면 고정 크기 오버레이 | 가장자리 근처에서 시작한 펜 획을 직선으로 투영, 회전 15° 스냅, 실제 크기 mm 눈금·cm 숫자, 긋는 동안 길이(cm) 표시 |
| 도형 | 직선/화살표/사각형/원 | Shift = 정사각형·정원, 15° 각도 스냅 |
| 암기 테이프 | 불투명 띠 | 드래그로 붙이고 탭(펜/손가락)으로 가림↔보임, 페이지 전체 보기/가리기, 동기화됨 |
| 지우개 | — | **획 지우개**, **부분 지우개**(재샘플링 후 분할, 도형은 폴리라인으로 변환해 분할), **형광펜만 지우개**. 이전→현재 위치 캡슐 판정으로 빠른 움직임에도 빈틈 없음. 한 번의 드래그 = 한 번의 undo |
| 올가미 | — | 포인트 50% 이상 포함된 객체 선택 → 드래그 이동, **핸들 8개**(모서리=비율 유지, 변=한 방향), 삭제·복제·복사/붙여넣기·색 변경 |

GoodNotes 편의 기능: **그리고 멈추면 직선**(0.5초, 수평/수직 ±5° 스냅), **두 손가락 탭 = 실행 취소 / 세 손가락 탭 = 다시 실행**, 펜 감지 시 손가락은 스크롤 전용, 속지 4종, 썸네일 사이드바, **다크 모드**(시스템/라이트/다크 — 종이는 PDF 가독성을 위해 흰색 유지).

## 6. PDF 열람 · 편집

- **열람**: pdf.js(legacy 빌드: 구형 WebView 호환). 워커에서 비동기 렌더, 줌 단계(√2 배수)별 해상도 캐시, 다운그레이드 없음, LRU(총 80MP) 메모리 상한.
- **편집**: PDF 가져오기(버튼 또는 **드래그 앤 드롭** — 라이브러리=새 노트, 편집 화면=현재 페이지 뒤 삽입), 페이지 추가·삭제·복제·순서 변경, 속지 변경, 모든 필기 도구로 주석.
- **내보내기**: pdf-lib 로 원본 페이지를 **그대로 복사**(텍스트·벡터 보존)하고 필기는 **PDF 벡터 경로**로 기록. 페이지 회전(0/90/180/270)·CropBox 오프셋 보정.
- PDF 원본은 **SHA-256 content-addressed blob** → 같은 파일 중복 저장/업로드 없음.

## 7. 웹 ↔ 앱 동기화

**LWW(Last-Writer-Wins) Element Map CRDT**
- 문서 = `(id → {kind, stamp, value|null})`. stamp = (Lamport 카운터, clientId) 전순서.
- 어떤 순서·중복으로 받아도 같은 상태로 수렴(교환·결합·멱등) → 오프라인 편집 후 병합이 안전.
- 획은 불변이라 객체 단위 LWW 로 충분: 그리기=put, 이동=같은 id put, 부분 지우기=tombstone + 조각 put.
- 페이지 순서는 **fractional index** 문자열이라 동시 삽입/이동도 충돌 없음.
- **undo/redo 도 "되돌리는 새 op"** → 다른 기기에도 그대로 반영. 그 사이 다른 기기가 고친 객체는 덮어쓰지 않음.

**프로토콜** (`packages/core/src/protocol.ts`)
```
C→S hello {docId, since}   →  S→C ops {ops, seq}     (since 이후 바뀐 엔트리만)
C→S push  {batch, ops}     →  S→C ack {batch, seq}   + 다른 구독자에게 ops 브로드캐스트
```
- 서버는 op 로그가 아니라 **현재 LWW 상태 + 엔트리별 seq** 만 저장 → 저장량이 문서 크기에 비례, 재접속 catch-up 이 O(변경분).
- 클라이언트: 모든 로컬 op → **outbox**(IndexedDB) → ack 받은 것만 제거. 끊기면 지수 백오프 재접속 후 재전송(LWW 라 멱등).
- PDF: `PUT/GET /api/blobs/:sha256` (서버가 해시 검증).

## 8. 모바일(Capacitor)

- `apps/web` 빌드(`dist`)를 iOS WKWebView / Android WebView 에 탑재 (`capacitor.config.ts`).
- Apple Pencil·S펜 필압은 Pointer Events(`pressure`, `pointerType: 'pen'`) 로 WebView 에서 그대로 들어온다.
- 로컬 저장: WebView 의 IndexedDB. 내보내기: 네이티브에서는 Web Share 시트로 파일 앱 저장/공유.
- `touch-action: none`, iOS 롱프레스 확대경 방지, safe-area 대응.

---

## 9. 구현 현황

| 영역 | 상태 | 위치 |
|---|---|---|
| 벡터 모델, 베지에, 필압/속도 굵기, 단순화 | ✅ | `packages/core` |
| 지우개 3종, 올가미 선택·이동·크기조절 | ✅ | `core/eraser.ts`, `core/selection.ts`, `web/engine/gestures.ts` |
| LWW CRDT 문서, undo/redo, 페이지 명령 | ✅ | `core/document.ts` |
| 저지연 4-레이어 캔버스 + 새 획 덧그리기, 팜 리젝션, 핀치 줌 | ✅ | `web/engine/Editor.ts` |
| 8종 필기 도구 + 도형 + 테이프, 멈추면 직선, 밑줄 PDF 자동 맞춤 | ✅ | `web/engine/gestures.ts`, `core/textsnap.ts` |
| 다크 모드, PDF 드래그 앤 드롭 | ✅ | `web/ui/theme.ts`, `web/ui/usePdfDrop.ts` |
| PDF 열람/가져오기/페이지 편집/내보내기 | ✅ | `web/engine/pdf.ts`, `exportPdf.ts` |
| 오프라인 저장 + 동기화 서버 | ✅ | `web/sync`, `apps/server` |
| Capacitor iOS/Android 설정 | ✅ (네이티브 프로젝트 생성은 Mac/Android SDK 에서) | `apps/web/capacitor.config.ts` |

테스트: 코어 27개 + 서버 2개 단위 테스트, 브라우저 E2E 34개 항목(실제 펜 이벤트·필압, 지우개 3종, 올가미 8핸들, 멈추면 직선, 밑줄 PDF 맞춤, 덧그리기 확인, 손가락 탭 undo/redo, 다크 모드, 드래그 앤 드롭, PDF 왕복, 2기기 동기화·undo 전파).

## 10. 다음 단계 (로드맵)

1. **인증/권한**: 서버에 JWT + 사용자별 문서 ACL, wss(TLS). 현재 서버는 인증 없음 → 신뢰된 네트워크에서만 사용.
2. **iOS 지연 최적화**: Capacitor 플러그인으로 `UITouch.predictedTouches`/`coalescedTouches` 기반 네이티브 잉크 레이어(PencilKit 또는 Metal) — 데이터 포맷은 동일하게 유지.
3. **대용량 문서**: 페이지별 lazy 로딩, 화면 타일 비트맵 캐시(팬 시 재렌더 최소화), IndexedDB 증분 저장(현재는 스냅샷 전체 저장).
4. **백그라운드 동기화**: 라이브러리에서 미전송 outbox 가 있는 모든 문서를 순회 동기화, 문서 삭제 tombstone.
5. **기능**: 다크 모드용 어두운 속지, 올가미 회전, 텍스트 상자·이미지, 도형 자동 인식(펜 멈춤), 필기 인식/검색(OCR), PDF 링크/목차, 다중 PDF 페이지 썸네일 그리드.
6. **동시 편집 고도화**: 같은 획을 동시에 이동+부분삭제하는 경우의 의도 보존이 필요하면 객체 내부를 시퀀스 CRDT 로 세분화.
