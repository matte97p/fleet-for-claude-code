import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Sidebar } from "./Sidebar";
import { Dashboard } from "./Dashboard";
import "./styles.css";

const el = document.getElementById("root")!;
const view = el.getAttribute("data-view");
createRoot(el).render(
  view === "sidebar" ? (
    <Sidebar />
  ) : view === "dashboard" ? (
    <Dashboard />
  ) : (
    <App />
  )
);
