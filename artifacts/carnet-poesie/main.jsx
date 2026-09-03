import { createRoot } from "react-dom/client";
import Poesie from "./Poesie.jsx";

// Le composant vient d'un artefact Claude et parle à window.storage ;
// sur GitHub Pages, on adosse cette API à localStorage pour garder la
// persistance sans toucher au code du composant.
if (!window.storage) {
  window.storage = {
    async get(key) {
      const value = localStorage.getItem("carnet-poesie:" + key);
      return value === null ? null : { key, value };
    },
    async set(key, value) {
      localStorage.setItem("carnet-poesie:" + key, value);
      return { key, value };
    },
    async remove(key) {
      localStorage.removeItem("carnet-poesie:" + key);
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

/* ------------------------------------------------------------------ */
/* Mode hors connexion                                                 */
/*                                                                     */
/* Même principe que window.storage : toute la plomberie du service    */
/* worker vit ici, le composant ne voit qu'une petite API. sw.js est   */
/* généré au build depuis sw.template.js (voir build.mjs).             */
/* ------------------------------------------------------------------ */

const supported = "serviceWorker" in navigator && window.isSecureContext;

let state = {
  supported,
  online: navigator.onLine,
  shell: false,
  vendor: { done: 0, total: 0, files: 0, count: 0 },
  fonts: null,
  warming: false,
  waiting: false,
  version: null,
};
const listeners = new Set();

const emit = (patch) => {
  state = { ...state, ...patch };
  for (const cb of listeners) { try { cb(state); } catch { /* l'UI ne doit rien casser ici */ } };
};

window.addEventListener("online", () => emit({ online: true }));
window.addEventListener("offline", () => emit({ online: false }));

/** Question au service worker, réponse par MessageChannel : on parle au worker
 *  qui contrôle la page, pas à celui qui attend son tour. */
function ask(type, timeout = 15000) {
  const worker = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeout);
    channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
    worker.postMessage({ type }, [channel.port2]);
  });
}

// C'est la page qui sait si un préchargement est en cours : le worker diffuse
// son état à chaque fichier, et ces messages peuvent arriver après la réponse
// finale (canaux distincts, ordre non garanti). Son « warming » n'est donc
// jamais repris tel quel.
let inFlight = false;
const apply = (answer) => {
  emit(answer ? { ...answer, warming: inFlight } : { warming: inFlight });
  return state;
};

window.offline = {
  get: () => state,
  subscribe(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  refresh: () => ask("STATUS").then(apply),
  warm: () => {
    if (inFlight) return Promise.resolve(state);
    inFlight = true;
    emit({ warming: true });
    // Le préchargement dure : l'avancement arrive entre-temps par les messages
    // OFFLINE_STATUS diffusés par le worker.
    return ask("WARM", 180000).then(
      (answer) => { inFlight = false; return apply(answer); },
      (error) => { inFlight = false; apply(null); throw error; },
    );
  },
  /** Demande au serveur s'il existe une version plus récente. Rend true si
   *  une mise à jour est en route (elle s'installe, puis `waiting` passe à
   *  vrai par l'écouteur `updatefound` — le bouton d'installation apparaît
   *  de lui-même), false si l'appareil a déjà la dernière. Demande le
   *  réseau : sans lui, on ne peut rien affirmer, donc false. */
  check() {
    if (!supported) return Promise.resolve(false);
    return navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return false;
      if (reg.waiting || reg.installing) return true;
      return reg.update().then(() => Boolean(reg.installing || reg.waiting));
    }).catch(() => false);
  },
  /** Applique une mise à jour en attente : le nouveau worker prend la main,
   *  puis la page recharge (controllerchange, plus bas). */
  update() {
    if (!supported) return false;
    navigator.serviceWorker.getRegistration().then((reg) => {
      const worker = reg && (reg.waiting || reg.installing);
      if (worker) worker.postMessage({ type: "SKIP_WAITING" });
      else if (reg) reg.update();
    });
    return true;
  },
};

/** Précharge les librairies si elles ne sont pas déjà complètes. Appelé au
 *  chargement plutôt qu'à l'activation du worker : c'est la page qui garde le
 *  worker en vie le temps du téléchargement. */
const warmIfNeeded = () => {
  if (!state.online) return; // rien à télécharger sans réseau
  if (state.vendor.done < state.vendor.total || state.fonts === false) window.offline.warm();
};

if (supported) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "OFFLINE_STATUS") apply(event.data.state);
  });

  // Première installation : le worker prend la main sans rechargement (rien
  // n'a changé sous les pieds de la page). Les prises de main suivantes, elles,
  // viennent d'une mise à jour acceptée : la page doit repartir sur le nouveau
  // code.
  let controlled = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlled) {
      controlled = true;
      window.offline.refresh().then(warmIfNeeded);
      return;
    }
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    // updateViaCache: "none" — la recherche de mise à jour de sw.js ne doit pas
    // passer par le cache HTTP, sinon une version figée le resterait.
    navigator.serviceWorker.register("./sw.js", { scope: "./", updateViaCache: "none" }).then((reg) => {
      const watch = () => emit({ waiting: Boolean(reg.waiting) });
      watch();
      reg.addEventListener("updatefound", () => {
        if (reg.installing) reg.installing.addEventListener("statechange", watch);
      });
      if (controlled) window.offline.refresh().then(warmIfNeeded);
    }).catch(() => emit({ supported: false }));
  });
}

createRoot(document.getElementById("root")).render(<Poesie />);
