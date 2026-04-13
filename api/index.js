/**
 * Vercel runs this file as a serverless function. Export the Express `app`
 * directly — Vercel's runtime handles it (do not wrap with serverless-http;
 * that can break `req.url` routing and cause 504s).
 */
import { app } from '../server/app.js'

export default app
