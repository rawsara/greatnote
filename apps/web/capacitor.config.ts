import type { CapacitorConfig } from '@capacitor/cli';

/**
 * iOS/Android 네이티브 셸 설정.
 * 웹 빌드(dist)를 WKWebView / Android WebView 에 탑재한다.
 *   npx cap add ios && npx cap add android  (최초 1회)
 *   npm run cap:ios | npm run cap:android
 */
const config: CapacitorConfig = {
  appId: 'com.inknote.app',
  appName: 'InkNote',
  webDir: 'dist',
  backgroundColor: '#ece9e3',
  ios: {
    contentInset: 'never',
    // Apple Pencil 입력이 스크롤 제스처에 먹히지 않도록
    scrollEnabled: false,
  },
  android: {
    // 개발 중 LAN 의 ws:// 동기화 서버 접속 허용 (운영에서는 wss:// 사용)
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
