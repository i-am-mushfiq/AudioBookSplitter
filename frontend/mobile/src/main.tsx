import React from "react";
import { createRoot } from "react-dom/client";
import ReaderPage from "../../app/reader/page";
import "./mobile.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ReaderPage />
  </React.StrictMode>,
);

if ("serviceWorker" in navigator && !window.location.protocol.startsWith("capacitor")) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("./service-worker.js"));
}
