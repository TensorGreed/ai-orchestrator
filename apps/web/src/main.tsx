import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "reactflow/dist/style.css";
import "./styles.css";
import "./styles/shell.css";
import "./styles/canvas.css";
import "./styles/inspector.css";
import "./styles/pages.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
