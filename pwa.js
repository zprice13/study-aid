/* Registers the Study Aid service worker.
 * The path is relative so it works both on localhost and under the
 * GitHub Pages subpath (https://zprice13.github.io/study-aid/).
 */
(function () {
  "use strict";

  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", function () {
    navigator.serviceWorker
      .register("sw.js")
      .then(function (registration) {
        console.log("[pwa] service worker registered, scope:", registration.scope);
      })
      .catch(function (err) {
        console.warn("[pwa] service worker registration failed:", err);
      });

    // When an updated service worker takes control, don't force-reload the
    // page mid-use — the new version applies on the next visit.
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      console.log("[pwa] new service worker active; refresh to get the latest version.");
    });
  });
})();
