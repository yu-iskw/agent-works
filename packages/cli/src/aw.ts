#!/usr/bin/env node
import { run } from './run.js';

const code = run(process.argv, process.stdout);
if (code !== 0) process.exitCode = code;
