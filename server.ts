/**
 * CoursePur Backend — Root Entry Point
 */

import 'dotenv/config';
import { startServer } from './src/app/server.js';

startServer().catch((error: unknown) => {
  console.error('Failed to start CoursePur Backend API:', error);
  process.exitCode = 1;
});
