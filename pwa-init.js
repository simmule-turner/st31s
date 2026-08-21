// ═══════════════════════════════════════════════════════════════════════
//  PWA Setup
//  Registers the web app manifest (as a blob URL, so no separate
//  manifest.webmanifest file is required) and the service worker.
//  Safe to load first or last relative to dcmath/dcengine/calc-ui — it has
//  no dependency on them and they have no dependency on it.
// ═══════════════════════════════════════════════════════════════════════
(function initPWA() {
  const manifest = {
    name: "dc Calculator",
    short_name: "dcCalc",
    id: "/dc-calculator",
    start_url: window.location.href.split('?')[0],
    scope: window.location.href.replace(/[^\/]*$/, ''),
    display: "standalone",
    background_color: "#f0f0f0",
    theme_color: "#333333",
    icons: [
      { src: "icon-192.png",          sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icon-512.png",          sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
  const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
  const manifestUrl = URL.createObjectURL(manifestBlob);
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = manifestUrl;
  document.head.appendChild(link);

  // Give the tab/home-screen icon the same graphic as the manifest icon.
  const iconLink = document.createElement('link');
  iconLink.rel = 'icon';
  iconLink.href = 'icon-512.png';
  document.head.appendChild(iconLink);

  const appleIconLink = document.createElement('link');
  appleIconLink.rel = 'apple-touch-icon';
  appleIconLink.href = 'icon-192.png';
  document.head.appendChild(appleIconLink);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => console.error('PWA SW failed:', err));
    });
  }
  
})();
