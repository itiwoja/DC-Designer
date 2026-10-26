// 製品版（Electron）の preload が公開する橋。開発版（ブラウザ）には無い
interface Window {
  dcDesktop?: import("../desktop/bridge").DesktopBridge;
}
