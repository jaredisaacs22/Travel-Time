// Worker entry: /api/* goes to the API handler, everything else is a static asset from ./public.
import { onRequest } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const path = pathname.slice('/api/'.length).split('/').filter(Boolean);
      return onRequest({ request, env, params: { path }, waitUntil: (p) => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },
};
