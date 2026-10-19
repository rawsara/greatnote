# iPad / Android 앱으로 설치하기

InkNote 앱은 웹 편집기를 Capacitor 로 감싼 네이티브 앱이다. 앱에서만 되는 것:

- **기기 내장 손글씨 인식** — iPad: Apple Vision(한국어는 iPadOS 16 이상), Android: Google ML Kit Digital Ink.
  인식은 기기 안에서만 이뤄지고 결과는 노트와 함께 동기화되어 웹에서도 검색된다.
- 사진 보관함·카메라에서 사진 넣기, 사진으로 스티커 만들기
- 파일 앱/메일/공유 시트에서 PDF·`.goodnotes` 파일을 **InkNote 로 열기**
- PDF 내보내기 → 공유 시트 (파일 앱에 저장, 다른 앱으로 보내기)

네이티브 프로젝트는 저장소에 들어 있다: `apps/web/ios` (Xcode, Swift Package Manager), `apps/web/android` (Gradle).
손글씨 인식 플러그인 소스는 `packages/ink-recognizer` (Swift / Java).

## iPad (Mac + 무료 Apple ID)

준비물: Mac, Xcode 16 이상(App Store), Node.js 22, USB-C 케이블(또는 같은 Wi-Fi), Apple ID.
유료 개발자 계정은 필요 없다. 대신 무료 계정으로 설치한 앱은 **7일 동안** 실행되고, 이후에는 Mac 에서 다시 실행(⌘R)하면 된다.

1. 받아서 빌드
   ```bash
   git clone https://github.com/rawsara/greatnote.git
   cd greatnote
   npm install
   npm run build
   cd apps/web && npx cap sync ios && npx cap open ios
   ```
   Xcode 가 열리면 Swift 패키지(Capacitor, 플러그인)를 처음 한 번 내려받는다 (왼쪽 아래 진행 표시).
2. Xcode 에 Apple ID 추가: **Xcode › Settings › Accounts › +** → Apple ID 로그인.
3. 서명 설정: 왼쪽에서 **App** 프로젝트 › **App** 타깃 › **Signing & Capabilities**
   - Team: 방금 추가한 "(Personal Team)" 선택
   - Bundle Identifier: `com.inknote.app` 은 다른 사람이 이미 썼을 수 있어서 바꿔야 한다. 예: `com.<내이름>.inknote`
4. iPad 연결 → 위쪽 실행 대상에서 내 iPad 선택. 처음이면 iPad 에서 "이 컴퓨터를 신뢰" 허용.
5. iPad 에서 **설정 › 개인정보 보호 및 보안 › 개발자 모드** 켜기 (재시동 필요).
6. Xcode 에서 ▶︎(⌘R). 처음 실행 때 "신뢰하지 않는 개발자" 가 뜨면
   iPad **설정 › 일반 › VPN 및 기기 관리** › 내 Apple ID › 신뢰.

코드를 고친 뒤에는 `npm run build && (cd apps/web && npx cap sync ios)` 후 Xcode 에서 다시 ▶︎.

## Android

- **APK 받기 (빌드 도구 없이)**: GitHub 저장소 › Actions › "Apps" 실행 기록 › Artifacts 의 `inknote-android-debug` 를 내려받아
  압축을 풀고 `app-debug.apk` 를 기기로 옮겨 설치 (설정에서 "출처를 알 수 없는 앱 설치" 허용).
- **직접 빌드**: Android Studio + JDK 21
  ```bash
  npm install && npm run build
  cd apps/web && npx cap sync android && npx cap open android   # ▶︎ Run
  # 또는: cd apps/web/android && ./gradlew assembleDebug
  ```

손글씨 인식 언어 모델(한국어, 약 20MB)은 처음 인식할 때 한 번 내려받는다. 그 뒤로는 오프라인에서도 인식된다.

## 기기 간 동기화

앱은 기본적으로 기기에만 저장한다. 여러 기기(iPad·Android·웹)를 맞추려면 같은 Wi-Fi 의 PC/Mac 에서 동기화 서버를 띄우고:

```bash
npm run dev:server     # ws://<PC IP>:8787
```

앱 라이브러리의 ⚙️ 에 `ws://192.168.0.10:8787` 처럼 입력한다 (같은 네트워크 접속 권한을 물으면 허용).
외부에서 쓰려면 서버를 HTTPS 뒤에 두고 `wss://` 주소를 쓴다.

## 손글씨 검색

- 노트 안: 상단 🔍 (⌘F). 손글씨·텍스트 상자·PDF 글자를 한 번에 찾고 위치를 강조한다.
  인식기가 단어를 잘못 끊어도 찾을 수 있도록 공백을 무시하고 비교하며, 인식 2·3순위 후보도 함께 본다.
- 라이브러리: 검색창에 입력하면 모든 노트에서 찾아 쪽 번호를 보여 주고, 누르면 그 검색어로 노트를 연다.
- 굿노트에서 가져온 노트는 굿노트가 만들어 둔 인식 결과를 그대로 가져와 바로 검색된다.
- 필기를 멈추고 2초쯤 지나면 그 페이지만 다시 인식한다. 웹 브라우저에는 인식기가 없어서
  다른 기기에서 인식·동기화된 결과로 검색한다.

## 스티커

상단 스티커 버튼: **기본 스티커**(벡터라 확대해도 선명) / **내 스티커**.
내 스티커는 올가미로 고른 필기·도형·이미지("선택한 것으로 만들기" 또는 선택 메뉴의 "스티커로"),
또는 사진·촬영으로 만든다. 내 스티커 보관함은 노트처럼 다른 기기와 동기화된다.
붙인 스티커는 한 묶음으로 선택·이동·크기 조절되고, 채운 도형은 선택 메뉴의 색으로 바꿀 수 있다.
