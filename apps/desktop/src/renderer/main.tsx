import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html has no element with the id root.");
}

createRoot(container).render(
  <StrictMode>
    <App electronVersion={window.desktop?.electronVersion} />
  </StrictMode>,
);
