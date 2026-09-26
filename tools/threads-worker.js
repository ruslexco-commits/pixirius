'use strict';

// Рабочий поток для tools/threads-check.js (Node, worker_threads): те же
// скрипты симуляции, что и в браузере (js/sim/worker.js), общая память,
// тот же цикл threadWorkerLoop.

const { workerData } = require('worker_threads');
const H = require('./harness');

const env = H.loadSim({ seed: workerData.seed });
const Sim = env.get('Sim');
const sim = new Sim(workerData.init.w, workerData.init.h);
env.get('attachSharedArrays')(sim, workerData.init);
env.get('threadWorkerLoop')(sim);
