import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
// App.jsx now lives alongside this file at the project root

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
