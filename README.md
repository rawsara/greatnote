# InkNote

GoodNotes 스타일 디지털 필기 + PDF 주석 앱 (웹 · iOS · Android, 실시간 동기화).
설계 문서는 [PLAN.md](./PLAN.md) 참고.

```
packages/core   플랫폼 독립 엔진: 벡터 모델, 베지에 보정, 필압/속도 굵기, 지우개, 올가미, LWW CRDT
apps/web        React + Canvas2D 편집기, pdf.js 열람, pdf-lib 내보내기, IndexedDB, 동기화 클라이언트
                (Capacitor 로 iOS/Android 앱 빌드)
apps/server     Node WebSocket 동기화 서버 + PDF blob 저장소
e2e             Playwright 브라우저 E2E (실제 펜 이벤트/필압)
```

## 실행

```bash
npm install
npm run dev:server     # 동기화 서버  ws://localhost:8787  (DATA_DIR=./data)
npm run dev            # 웹 앱        http://localhost:5173  (--host 로 LAN 노출)
```

태블릿에서 테스트: 같은 Wi-Fi 에서 `http://<PC IP>:5173` 접속 → 동기화 서버는 자동으로 `ws://<PC IP>:8787` 사용.
라이브러리 ⚙️ 에서 서버 주소를 바꾸거나 비워서(로컬 전용) 쓸 수 있다.

## 테스트

```bash
npm test               # core 단위 테스트 + 서버 동기화 테스트
npm run typecheck
# E2E: 서버(8787)와 `npm run build && npx vite preview --port 4173` 실행 후
CHROMIUM_PATH=/path/to/chrome node e2e/e2e.mjs   # 합성 .goodnotes 파일을 만들어 가져오기까지 검사
```

## iOS / Android

```bash
cd apps/web
npx cap add ios        # macOS + Xcode 필요 (최초 1회)
npx cap add android    # Android Studio/SDK 필요 (최초 1회)
npm run cap:ios        # 빌드 → 동기화 → Xcode 열기
npm run cap:android    # 빌드 → 동기화 → Android Studio 열기
```

앱에서는 라이브러리 ⚙️ 에 동기화 서버 주소(예: `ws://192.168.0.10:8787`, 운영은 `wss://`)를 입력한다.
iOS 에서 http/ws 개발 서버에 붙으려면 Info.plist 의 ATS 예외(NSAllowsLocalNetworking)가 필요하다.

## 굿노트에서 옮겨오기

굿노트에서 노트를 **GoodNotes 형식(.goodnotes)** 으로 내보낸 뒤, 라이브러리의 “굿노트 가져오기” 버튼을 누르거나
파일을 화면에 끌어다 놓으면 새 노트로 만들어진다. 필기는 이미지가 아닌 벡터 획으로 들어와서 지우개·올가미로 그대로 이어서 편집할 수 있다.

가져오는 것: 펜 필기(굵기 변화 포함), 형광펜, 도형, 스티커(묶음으로 선택), 이미지, 텍스트 상자, 페이지 텍스트, 속지 템플릿, 용지 크기.
가져오지 않는 것: 지운 획, 손글씨 인식(검색) 데이터. 굿노트 비공개 형식이라 굿노트 업데이트로 형식이 바뀌면 일부가 빠질 수 있으며, 이때는 결과 화면에 경고가 표시된다.

## 단축키 (웹)

| 키 | 동작 | 키 | 동작 |
|---|---|---|---|
| P | 만년필 | E | 지우개 |
| N | 연필 | L | 올가미 |
| B | 볼펜(필압 없음) | S | 도형 |
| M | 마카 | T | 암기 테이프 |
| H | 형광펜 | U | 밑줄 |
| X | 텍스트 | | |
| ⌘Z / ⇧⌘Z | 실행 취소 / 다시 실행 | ⌘C ⌘V ⌘D | 복사 / 붙여넣기 / 복제 |
| Space+드래그, 휠 | 이동 | ⌘+휠 | 확대/축소 |

터치: 한 손가락 스크롤(펜 사용 시), 두 손가락 핀치 줌, **두 손가락 탭 = 실행 취소, 세 손가락 탭 = 다시 실행**, 테이프 탭 = 가림/보임.
펜: 그리다가 0.5초 멈추면 직선으로 바뀜. PDF 는 화면에 끌어다 놓아도 열림. 상단 🌙 버튼으로 시스템/라이트/다크 전환.
