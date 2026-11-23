"use strict";
/* ============================================================
   Serch Education — Service Worker (PWA)
   Guarda en caché las páginas y los recursos propios para que
   la app se pueda instalar y abra rápido — incluido el registro
   de escuelas (escuelas.json), la fuente primaria de datos.
   Los servicios externos (Overpass API, solo del botón opcional
   «Actualizar en vivo», y los mosaicos del mapa de CARTO) NO se
   cachean aquí.
   serch-v6: ruptura limpia de las cachés mezcladas que dejaron
   las subidas rápidas de versiones anteriores.
   ============================================================ */
const CACHE = "serch-v6";
const PROPIOS = [
  "./",
  "index.html",
  "mapa.html",
  "escuela.html",
  "eventos.html",
  "acerca.html",
  "estilos.css",
  "app.js",
  "manifest.json",
  "eventos.json",
  "datos-extra.json",
  "escuelas.json",
  "assets/marcador-centro.png",
  "assets/icono-busqueda.png",
  "assets/icono-kinder.png",
  "assets/icono-primaria.png",
  "assets/icono-secundaria.png",
  "assets/icono-preparatoria.png",
  "assets/icono-egresado.png",
  "assets/icono-costos.png",
  "assets/icono-gratuitas.png",
  "assets/icono-beneficios.png",
  "assets/icono-radar.png",
  "assets/icono-distancia.png",
  "assets/icono-eventos.png",
  "assets/icon-192.png",
  "assets/icon-512.png"
];

self.addEventListener("install", ev => {
  ev.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PROPIOS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", ev => {
  ev.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", ev => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // externos: directo a la red
  // Los archivos de datos del repo van primero a la red (que no se
  // quede un registro ni una investigación viejos); el resto, caché primero.
  const esDato = url.pathname.endsWith("datos-extra.json") || url.pathname.endsWith("eventos.json") ||
    url.pathname.endsWith("escuelas.json");
  if (esDato) {
    ev.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then(c => c.put(req, copia));
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }
  ev.respondWith(
    caches.match(req, { ignoreSearch: true }).then(enCache => {
      const aLaRed = fetch(req).then(res => {
        if (res && res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then(c => c.put(req, copia));
        }
        return res;
      }).catch(() => enCache);
      return enCache || aLaRed;
    })
  );
});
