import { createRoot } from "react-dom/client";
import Carnet from "./Carnet.jsx";

// Le composant vient d'un artefact Claude et parle à window.storage ;
// sur GitHub Pages, on adosse cette API à localStorage pour garder la
// persistance sans toucher au code du composant.
if (!window.storage) {
  window.storage = {
    async get(key) {
      const value = localStorage.getItem("carnet-accords:" + key);
      return value === null ? null : { key, value };
    },
    async set(key, value) {
      localStorage.setItem("carnet-accords:" + key, value);
      return { key, value };
    },
  };
}

createRoot(document.getElementById("root")).render(<Carnet />);
