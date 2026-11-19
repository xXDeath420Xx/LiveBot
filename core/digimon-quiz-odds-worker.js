/* Worker for core/digimon-quiz-odds.js: does the year of quiz runs off the main thread and posts the result. */
import { parentPort, workerData } from 'node:worker_threads';
import { computeQuizOdds } from './digimon-quiz-odds.js';

parentPort.postMessage(computeQuizOdds(workerData.digimon, { startMs: workerData.startMs, bank: workerData.bank }));
