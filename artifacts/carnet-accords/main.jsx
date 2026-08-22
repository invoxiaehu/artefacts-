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
    async remove(key) {
      localStorage.removeItem("carnet-accords:" + key);
    },
  };
}

// ?maj=<timestamp> ne sert qu'à contourner le cache lors d'un rechargement
// forcé (Réglages) : on le retire de la barre d'adresse une fois chargé.
if (/[?&]maj=/.test(window.location.search)) {
  const params = new URLSearchParams(window.location.search);
  params.delete("maj");
  const qs = params.toString();
  window.history.replaceState(null, "",
    window.location.pathname + (qs ? "?" + qs : "") + window.location.hash);
}

createRoot(document.getElementById("root")).render(<Carnet />);
