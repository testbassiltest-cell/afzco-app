const CACHE_NAME = 'afzco-cache-v1';
const ASSETS = [
  '/',
  'index.html',
  'style.css',
  'script.js',
  'manifest.json',
  'icons/icon-192x192.png',
  'icons/icon-512x512.png',
  // HTML pages
  'actions.html',
  'audit_detail.html',
  'audit_logs.html',
  'audits.html',
  'change.html',
  'change_detail.html',
  'closure_report.html',
  'complaint_detail.html',
  'complaints.html',
  'dashboard.html',
  'employee_detail.html',
  'employees.html',
  'equipment.html',
  'equipment_detail.html',
  'login.html',
  'mom.html',
  'mom_detail.html',
  'permit_detail.html',
  'permits.html',
  'risk.html',
  'risk_detail.html',
  'safety.html',
  'safety_detail.html',
  'sds.html',
  'sds_detail.html',
  'settings.html',
  'training.html',
  'training_detail.html'
];

// Install event: cache all known assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

// Activate event: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Fetch event: serve from cache first, then network fallback
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return (
        response ||
        fetch(event.request).catch(() => {
          // If offline and request is for HTML, return cached index page
          if (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html')) {
            return caches.match('index.html');
          }
        })
      );
    })
  );
});