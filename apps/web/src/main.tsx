import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles/dashboard.css";
import "./styles/settings.css";

const host = document.getElementById("root");
if (!host) throw new Error("no #root");
createRoot(host).render(<StrictMode><App /></StrictMode>);
