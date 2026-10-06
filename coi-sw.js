'use strict';

// Сервис-воркер изоляции страницы для статического хостинга (GitHub Pages).
//
// Многопоточной симуляции (js/sim/threads.js) нужен SharedArrayBuffer, а он
// есть только у страницы с заголовками COOP/COEP. Локальный сервер
// (tools/serve.js) их шлёт, а GitHub Pages свои заголовки ставить не даёт.
// Этот воркер стоит между страницей и сервером и добавляет оба заголовка к
// каждому ответу своего сайта. Регистрирует его index.html, и только когда
// страница без изоляции: локально он не нужен и не ставится.
//
// COEP — require-corp: чужие ресурсы (скрипт с CDN для сетевой игры)
// должны приходить с CORS (атрибут crossorigin у тега), иначе браузер их не
// пустит.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Такой запрос (only-if-cached не со своего сайта) fetch из воркера не
  // выполнит — пусть идёт мимо.
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith(fetch(req).then((res) => {
    // Непрозрачный ответ (чужой сайт без CORS) заголовков не меняет.
    if (res.status === 0) return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }));
});
