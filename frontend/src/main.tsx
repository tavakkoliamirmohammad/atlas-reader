import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/globals.css";

// Note: React.StrictMode is intentionally NOT used because it double-mounts
// components, which destroys the PDF.js worker mid-creation. See react-pdf
// issue tracker; StrictMode + Web Workers is a known incompatibility.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
