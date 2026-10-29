import { createRoot } from "react-dom/client";
import { Application } from "./Application";
import "./styles.css";

// useHistory は state 更新関数内で履歴を積むため StrictMode（二重実行）は使わない
createRoot(document.getElementById("root")!).render(
  <Application params={new URLSearchParams(location.search)} />,
);
