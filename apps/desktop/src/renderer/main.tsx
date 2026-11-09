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
    <App
      electronVersion={window.desktop?.electronVersion}
      runtime={window.desktop?.runtime}
      repositories={window.desktop?.repositories}
      account={window.desktop?.account}
      connection={window.desktop?.connection}
      workspaces={window.desktop?.workspaces}
      people={window.desktop?.people}
      peopleActions={window.desktop?.peopleActions}
      agents={window.desktop?.agents}
      chat={window.desktop?.chat}
      devices={window.desktop?.devices}
    />
  </StrictMode>,
);
