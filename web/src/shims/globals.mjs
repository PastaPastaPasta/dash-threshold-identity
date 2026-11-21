import { Buffer } from 'buffer';

globalThis.Buffer ??= Buffer;
globalThis.process ??= { env: {}, browser: true, version: '', versions: {}, nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)) };
globalThis.global ??= globalThis;
