import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { SessionProvider } from "./components/Session";
import { FirmProvider } from "./components/Firm";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <FirmProvider>
          <App />
        </FirmProvider>
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
