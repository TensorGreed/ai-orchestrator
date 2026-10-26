/**
 * Entry of the static demo build: the studio as usual (`../main`), plus the
 * demo banner, notices and tour in a root of their own.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import "./demo-boot";
import "../main";
import { DemoChrome } from "./DemoChrome";
import "./demo.css";

const host = document.createElement("div");
host.id = "l2m-demo-chrome";
document.body.appendChild(host);

ReactDOM.createRoot(host).render(
  <React.StrictMode>
    <DemoChrome />
  </React.StrictMode>
);
